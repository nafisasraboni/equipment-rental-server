import { Router } from "express";
import { z } from "zod";
import type { Document, Filter } from "mongodb";
import type { Equipment, User } from "../types";
import { verifyToken, verifyOwner, verifyAdmin, requireRoles } from "../middleware/auth";
import { catalogSchema, cleanQuery, equipmentSchema, escapeRegex, idSchema, pageSchema } from "../lib/validation";
import { ApiError, success } from "../lib/errors";
import { today } from "../lib/dates";
import { equipmentDto, paginated } from "../lib/serialize";
import { availableQuantity, lockEquipment, reservedQuantity } from "../services/inventory";

function availabilityPipeline(day: string): Document[] {
  return [
    { $lookup: { from: "bookings", let: { equipmentId: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$equipmentId", "$$equipmentId"] }, { $lte: ["$startDate", day] }, { $gte: ["$endDate", day] }] } } }, { $group: { _id: null, reserved: { $sum: "$quantity" } } }], as: "paidStock" } },
    { $lookup: { from: "rentalIntents", let: { equipmentId: "$_id" }, pipeline: [{ $match: { status: { $in: ["creating", "open"] }, $expr: { $and: [{ $eq: ["$equipmentId", "$$equipmentId"] }, { $lte: ["$startDate", day] }, { $gte: ["$endDate", day] }] } } }, { $group: { _id: null, reserved: { $sum: "$quantity" } } }], as: "heldStock" } },
    { $addFields: { availableQuantity: { $max: [0, { $subtract: ["$quantity", { $add: [{ $ifNull: [{ $arrayElemAt: ["$paidStock.reserved", 0] }, 0] }, { $ifNull: [{ $arrayElemAt: ["$heldStock.reserved", 0] }, 0] }] }] }] } } },
    { $lookup: { from: "users", localField: "ownerId", foreignField: "_id", as: "owners" } },
    { $project: { paidStock: 0, heldStock: 0 } }
  ];
}

interface CatalogRow extends Equipment { availableQuantity: number; owners: User[] }

export function equipmentRoutes() {
  const router = Router();

  router.get("/equipment", async (req, res) => {
    const query = catalogSchema.parse(cleanQuery(req.query));
    const match: Filter<Equipment> = { status: "approved", deletedAt: { $exists: false } };
    if (query.search) {
      const search = new RegExp(escapeRegex(query.search), "i");
      match.$or = [{ name: search }, { location: search }, { category: search }];
    }
    if (query.category) match.category = query.category;
    if (query.rentalType) match.rentalType = query.rentalType;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) match.rentalPriceCents = { ...(query.minPrice !== undefined ? { $gte: Math.round(query.minPrice * 100) } : {}), ...(query.maxPrice !== undefined ? { $lte: Math.round(query.maxPrice * 100) } : {}) };
    const pipeline: Document[] = [{ $match: match }, ...availabilityPipeline(today())];
    if (query.availability !== "all") pipeline.push({ $match: { availableQuantity: query.availability === "available" ? { $gt: 0 } : 0 } });
    const sort = query.sort === "price_asc" ? { rentalPriceCents: 1, _id: 1 } : query.sort === "price_desc" ? { rentalPriceCents: -1, _id: 1 } : { createdAt: -1, _id: 1 };
    pipeline.push({ $facet: { items: [{ $sort: sort }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], count: [{ $count: "total" }] } });
    const [result] = await req.context.db.collection<Equipment>("equipment").aggregate<{ items: CatalogRow[]; count: { total: number }[] }>(pipeline).toArray();
    const items = (result?.items ?? []).map(({ owners, ...equipment }) => equipmentDto(equipment, equipment.availableQuantity, owners[0]));
    success(res, paginated(items, query.page, query.limit, result?.count[0]?.total ?? 0));
  });

  router.get("/equipment/featured", async (req, res) => {
    const rows = await req.context.db.collection<Equipment>("equipment").aggregate<CatalogRow>([{ $match: { status: "approved", deletedAt: { $exists: false } } }, { $sort: { createdAt: -1 } }, { $limit: 6 }, ...availabilityPipeline(today())]).toArray();
    success(res, rows.map(({ owners, ...equipment }) => equipmentDto(equipment, equipment.availableQuantity, owners[0])));
  });

  router.get("/equipment/home", async (req, res) => {
    const rows = await req.context.db.collection<Equipment>("equipment").aggregate<CatalogRow>([{ $match: { status: "approved", deletedAt: { $exists: false } } }, { $sort: { createdAt: -1 } }, { $limit: 6 }, ...availabilityPipeline(today())]).toArray();
    const featured = rows.map(({ owners, ...equipment }) => equipmentDto(equipment, equipment.availableQuantity, owners[0]));
    success(res, { featured, recent: featured.slice(0, 4) });
  });

  const managedList = (admin: boolean) => async (req: Parameters<typeof verifyToken>[0], res: Parameters<typeof verifyToken>[1]) => {
    const query = pageSchema.parse(cleanQuery(req.query));
    const filter: Filter<Equipment> = { deletedAt: { $exists: false }, ...(!admin ? { ownerId: req.user._id } : {}) };
    if (admin && req.query.status && req.query.status !== "all") filter.status = z.enum(["pending", "approved", "rejected"]).parse(req.query.status);
    const [equipment, total] = await Promise.all([req.context.db.collection<Equipment>("equipment").find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray(), req.context.db.collection<Equipment>("equipment").countDocuments(filter)]);
    const items = [];
    for (const item of equipment) {
      const owner = await req.context.db.collection<User>("users").findOne({ _id: item.ownerId });
      items.push(equipmentDto(item, await availableQuantity(req.context.db, item, today(), today()), owner));
    }
    success(res, paginated(items, query.page, query.limit, total));
  };
  router.get("/owner/equipment", verifyToken, verifyOwner, managedList(false));
  router.get("/admin/equipment", verifyToken, verifyAdmin, managedList(true));

  router.get("/equipment/:id", verifyToken, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const equipment = await req.context.db.collection<Equipment>("equipment").findOne({ _id: id, deletedAt: { $exists: false } });
    if (!equipment) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "This equipment is no longer available.");
    if (equipment.status !== "approved" && req.user.role !== "admin" && !(req.user.role === "owner" && equipment.ownerId === req.user._id)) throw new ApiError(403, "EQUIPMENT_NOT_APPROVED", "This equipment is awaiting approval or unavailable.");
    const owner = await req.context.db.collection<User>("users").findOne({ _id: equipment.ownerId });
    success(res, equipmentDto(equipment, await availableQuantity(req.context.db, equipment, today(), today()), owner));
  });

  router.post("/equipment", verifyToken, verifyOwner, async (req, res) => {
    const body = equipmentSchema.parse(req.body);
    const now = new Date();
    const equipment: Equipment = { ...body, _id: crypto.randomUUID(), ownerId: req.user._id, status: "pending", inventoryRevision: 0, createdAt: now, updatedAt: now };
    await req.context.db.collection<Equipment>("equipment").insertOne(equipment);
    success(res, equipmentDto(equipment, equipment.quantity, req.user), 201, "Equipment submitted for approval.");
  });

  router.patch("/equipment/:id", verifyToken, requireRoles("owner", "admin"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const body = equipmentSchema.partial().strict().refine((value) => Object.keys(value).length > 0).parse(req.body);
    const session = req.context.client.startSession();
    let updated: Equipment | null = null;
    try {
      await session.withTransaction(async () => {
        const current = await lockEquipment(req.context.db, id, session);
        if (req.user.role !== "admin" && current.ownerId !== req.user._id) throw new ApiError(403, "FORBIDDEN", "You can update only your own equipment.");
        if (body.quantity !== undefined && body.quantity < await reservedQuantity(req.context.db, id, today(), "9999-12-31", session)) throw new ApiError(409, "RESERVED_STOCK", "Quantity cannot be reduced below existing rental reservations.");
        updated = await req.context.db.collection<Equipment>("equipment").findOneAndUpdate({ _id: id }, { $set: { ...body, ...(req.user.role === "owner" ? { status: "pending" } : {}), updatedAt: new Date() }, ...(req.user.role === "owner" ? { $unset: { rejectionReason: "" } } : {}) }, { session, returnDocument: "after" });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
    } finally { await session.endSession(); }
    if (!updated) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found.");
    const result: Equipment = updated;
    const owner = await req.context.db.collection<User>("users").findOne({ _id: result.ownerId });
    success(res, equipmentDto(result, await availableQuantity(req.context.db, result, today(), today()), owner), 200, "Equipment updated.");
  });

  router.delete("/equipment/:id", verifyToken, requireRoles("owner", "admin"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const filter: Filter<Equipment> = { _id: id, deletedAt: { $exists: false }, ...(req.user.role === "owner" ? { ownerId: req.user._id } : {}) };
    const result = await req.context.db.collection<Equipment>("equipment").updateOne(filter, { $set: { deletedAt: new Date(), updatedAt: new Date() }, $inc: { inventoryRevision: 1 } });
    if (!result.matchedCount) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found or not owned by you.");
    success(res, { id }, 200, "Equipment removed. Existing rental history is preserved.");
  });

  router.patch("/admin/equipment/:id/status", verifyToken, verifyAdmin, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const body = z.object({ status: z.enum(["pending", "approved", "rejected"]), rejectionReason: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const equipment = await req.context.db.collection<Equipment>("equipment").findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: { ...body, updatedAt: new Date() }, ...(body.status !== "rejected" ? { $unset: { rejectionReason: "" } } : {}) }, { returnDocument: "after" });
    if (!equipment) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found.");
    const owner = await req.context.db.collection<User>("users").findOne({ _id: equipment.ownerId });
    success(res, equipmentDto(equipment, await availableQuantity(req.context.db, equipment, today(), today()), owner));
  });
  return router;
}
