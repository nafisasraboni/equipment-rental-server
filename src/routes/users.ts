import { Router } from "express";
import { z } from "zod";
import type { Filter } from "mongodb";
import type { User } from "../types";
import { verifyToken, verifyAdmin } from "../middleware/auth";
import { ApiError, success } from "../lib/errors";
import { cleanQuery, idSchema, pageSchema, profileSchema } from "../lib/validation";
import { paginated, userDto } from "../lib/serialize";

export function userRoutes() {
  const router = Router();
  router.get("/me", verifyToken, (req, res) => success(res, userDto(req.user)));
  router.patch("/me", verifyToken, async (req, res) => {
    const body = profileSchema.parse(req.body);
    const user = await req.context.db.collection<User>("users").findOneAndUpdate({ _id: req.user._id }, { $set: { ...body, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "Account not found.");
    success(res, userDto(user), 200, "Profile updated.");
  });
  router.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    const query = pageSchema.parse(cleanQuery(req.query));
    const filter: Filter<User> = {};
    if (req.query.role && req.query.role !== "all") filter.role = z.enum(["customer", "owner", "admin"]).parse(req.query.role);
    const [users, total] = await Promise.all([req.context.db.collection<User>("users").find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray(), req.context.db.collection<User>("users").countDocuments(filter)]);
    success(res, paginated(users.map(userDto), query.page, query.limit, total));
  });
  router.patch("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const body = z.object({ role: z.enum(["customer", "owner", "admin"]).optional(), status: z.enum(["active", "suspended"]).optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(req.body);
    const session = req.context.client.startSession();
    let updated: User | null = null;
    try {
      await session.withTransaction(async () => {
        await req.context.db.collection<{ _id: string; revision: number }>("system").updateOne({ _id: "admin-guard" }, { $inc: { revision: 1 } }, { session, upsert: true });
        const user = await req.context.db.collection<User>("users").findOne({ _id: id }, { session });
        if (!user) throw new ApiError(404, "USER_NOT_FOUND", "Account not found.");
        const removingAdmin = user.role === "admin" && user.status !== "suspended" && (body.role && body.role !== "admin" || body.status === "suspended");
        if (removingAdmin && await req.context.db.collection<User>("users").countDocuments({ role: "admin", status: { $ne: "suspended" } }, { session }) <= 1) throw new ApiError(409, "LAST_ADMIN", "The last active administrator cannot be suspended or demoted.");
        updated = await req.context.db.collection<User>("users").findOneAndUpdate({ _id: id }, { $set: { ...body, updatedAt: new Date() } }, { session, returnDocument: "after" });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
    } finally { await session.endSession(); }
    if (!updated) throw new ApiError(404, "USER_NOT_FOUND", "Account not found.");
    success(res, userDto(updated), 200, "User permissions updated.");
  });
  return router;
}
