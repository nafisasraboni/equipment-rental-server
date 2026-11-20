import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import cron from "node-cron";
import { createApp } from "./app";
import { withDatabase } from "./lib/database";
import type { Env, RequestContext } from "./types";
import { runScheduledJobs } from "./services/scheduled";

if (existsSync(".env")) process.loadEnvFile(".env");
const origin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";
const port = Number(process.env.PORT ?? 8787);
const env: Env = {
  MONGODB_URI: process.env.MONGODB_URI ?? "",
  MONGODB_DB: process.env.MONGODB_DB ?? "gearnest",
  CLIENT_ORIGIN: origin,
  AUTH_ISSUER: process.env.AUTH_ISSUER ?? origin.split(",")[0],
  JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? `http://localhost:${port}`,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  IMGBB_API_KEY: process.env.IMGBB_API_KEY ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  CURRENCY: "USD"
};
const context = new AsyncLocalStorage<RequestContext>();
const app = createApp(() => {
  const current = context.getStore();
  if (!current) throw new Error("Request context is unavailable.");
  return current;
});
const server = createServer(async (req, res) => {
  try {
    await withDatabase(env, (db, client) => context.run({ env, db, client }, () => new Promise<void>((resolve) => {
      res.once("finish", resolve);
      res.once("close", resolve);
      app(req, res);
    })));
  } catch (error) {
    console.error("Local API request failed", { type: error instanceof Error ? error.name : "UnknownError" });
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: { code: "SERVICE_UNAVAILABLE", message: "The database service is unavailable. Please retry." } }));
    }
  }
});
server.listen(port, "127.0.0.1", () => console.log(`GearNest API listening at http://localhost:${port}`));

cron.schedule("*/5 * * * *", async () => {
  try { await withDatabase(env, (db, client) => runScheduledJobs(env, db, client)); }
  catch (error) { console.error("Scheduled GearNest jobs failed", { type: error instanceof Error ? error.name : "UnknownError" }); }
}, { name: "gearnest-rental-completion", timezone: "Asia/Dhaka", noOverlap: true, unref: true });
