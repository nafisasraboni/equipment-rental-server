import { Router } from "express";
import type { Equipment, User } from "../types";
import { verifyToken, verifyRenter } from "../middleware/auth";
import { ApiError, success } from "../lib/errors";
import { cleanQuery, idSchema, pageSchema } from "../lib/validation";
import { equipmentDto, paginated } from "../lib/serialize";
import { availableQuantity } from "../services/inventory";
import { today } from "../lib/dates";

interface Favorite { _id: string; customerId: string; equipmentId: string; createdAt: Date }

export function favoriteRoutes() {
  const router = Router();
  router.use("/favorites", verifyToken, verifyRenter);
  router.get("/favorites", async (req, res) => {
    const query = pageSchema.parse(cleanQuery(req.query));
    const collection = req.context.db.collection<Favorite>("favorites");
    const [favorites, total] = await Promise.all([collection.find({ customerId: req.user._id }).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray(), collection.countDocuments({ customerId: req.user._id })]);
    const items = [];
    for (const favorite of favorites) {
      const equipment = await req.context.db.collection<Equipment>("equipment").findOne({ _id: favorite.equipmentId, status: "approved", deletedAt: { $exists: false } });
      const owner = equipment ? await req.context.db.collection<User>("users").findOne({ _id: equipment.ownerId }) : null;
      items.push({ id: favorite._id, equipmentId: favorite.equipmentId, createdAt: favorite.createdAt.toISOString(), equipment: equipment ? equipmentDto(equipment, await availableQuantity(req.context.db, equipment, today(), today()), owner) : null });
    }
    success(res, paginated(items, query.page, query.limit, total));
  });
  router.put("/favorites/:equipmentId", async (req, res) => {
    const equipmentId = idSchema.parse(req.params.equipmentId);
    const equipment = await req.context.db.collection<Equipment>("equipment").findOne({ _id: equipmentId, status: "approved", deletedAt: { $exists: false } });
    if (!equipment) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "Only approved equipment can be saved.");
    await req.context.db.collection<Favorite>("favorites").updateOne({ customerId: req.user._id, equipmentId }, { $setOnInsert: { _id: crypto.randomUUID(), customerId: req.user._id, equipmentId, createdAt: new Date() } }, { upsert: true });
    success(res, { equipmentId }, 200, "Equipment saved to favorites.");
  });
  router.delete("/favorites/:equipmentId", async (req, res) => {
    const equipmentId = idSchema.parse(req.params.equipmentId);
    await req.context.db.collection<Favorite>("favorites").deleteOne({ customerId: req.user._id, equipmentId });
    success(res, { equipmentId }, 200, "Equipment removed from favorites.");
  });
  return router;
}
