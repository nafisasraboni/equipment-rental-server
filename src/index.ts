import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { handleAsNodeRequest } from "cloudflare:node";
import { createApp } from "./app";
import type { Env, RequestContext } from "./types";
import { withDatabase } from "./lib/database";
import { runScheduledJobs } from "./services/scheduled";

const requestContext = new AsyncLocalStorage<RequestContext>();
const app = createApp(() => {
  const context = requestContext.getStore();
  if (!context) throw new Error("Request context is unavailable.");
  return context;
});
createServer(app).listen(3000);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await withDatabase(env, (db, client) => requestContext.run({ env, db, client }, () => handleAsNodeRequest(3000, request)));
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
