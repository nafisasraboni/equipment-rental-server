import express from "express";
import cors from "cors";
import type { RequestContext } from "./types";
import { ApiError, errorHandler, success } from "./lib/errors";
import { equipmentRoutes } from "./routes/equipment";
import { userRoutes } from "./routes/users";
import { favoriteRoutes } from "./routes/favorites";
import { bookingRoutes, stripeWebhookRoutes } from "./routes/bookings";
import { analyticsRoutes } from "./routes/analytics";
import { uploadRoutes } from "./routes/uploads";

export function createApp(getContext: () => RequestContext) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    req.context = getContext();
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(cors({ origin(origin, callback) {
    const allowed = getContext().env.CLIENT_ORIGIN.split(",").map((value) => value.trim());
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new ApiError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed."));
  }, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"], maxAge: 600 }));
  app.use("/api", stripeWebhookRoutes());
  app.use("/api", uploadRoutes());
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", async (req, res) => {
    await req.context.db.command({ ping: 1 });
    success(res, { service: "GearNest API", database: "connected", mode: "sandbox" });
  });
  app.use("/api", userRoutes());
  app.use("/api", equipmentRoutes());
  app.use("/api", favoriteRoutes());
  app.use("/api", bookingRoutes());
  app.use("/api", analyticsRoutes());
  app.use((_req, _res, next) => next(new ApiError(404, "ROUTE_NOT_FOUND", "This API endpoint does not exist.")));
  app.use(errorHandler);
  return app;
}
