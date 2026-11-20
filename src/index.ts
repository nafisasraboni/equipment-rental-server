import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { handleAsNodeRequest } from "cloudflare:node";
import { createApp } from "./app";
import type { Env, RequestContext } from "./types";
import { withDatabase } from "./lib/database";
import { runScheduledJobs } from "./services/scheduled";

const requestContext = new AsyncLocalStorage<RequestContext>();
const publicEquipmentPaths = new Set(["/api/equipment", "/api/equipment/featured", "/api/equipment/home"]);
const edgeCache = (caches as CacheStorage & { default: Cache }).default;

function publicCacheKey(request: Request) {
  if (request.method !== "GET" || request.headers.has("Authorization")) return null;
  const url = new URL(request.url);
  if (!publicEquipmentPaths.has(url.pathname)) return null;
  url.searchParams.set("__gearnest_origin", request.headers.get("Origin") ?? "none");
  return new Request(url.toString(), { method: "GET" });
}

const app = createApp(() => {
  const context = requestContext.getStore();
  if (!context) throw new Error("Request context is unavailable.");
  return context;
});
createServer(app).listen(3000);

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const cacheKey = publicCacheKey(request);
      if (cacheKey) {
        const cached = await edgeCache.match(cacheKey);
        if (cached) return cached;
      }
      const response = await withDatabase(env, (db, client) => requestContext.run({ env, db, client }, () => handleAsNodeRequest(3000, request)));
      if (!cacheKey || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=120");
      const cacheable = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      context.waitUntil(edgeCache.put(cacheKey, cacheable.clone()));
      return cacheable;
    } catch (error) {
      console.error("Worker request failed", { type: error instanceof Error ? error.name : "UnknownError" });
      const origin = request.headers.get("Origin");
      const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };
      if (origin && env.CLIENT_ORIGIN?.split(",").map((value) => value.trim()).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
      return Response.json({ success: false, error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable. Please retry." } }, { status: 503, headers });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await withDatabase(env, (db, client) => runScheduledJobs(env, db, client));
  }
};
