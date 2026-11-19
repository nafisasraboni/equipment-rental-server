import type { ClientSession, Db } from "mongodb";
import type { Booking, Equipment, RentalIntent } from "../types";
import { ApiError } from "../lib/errors";
import { peakReservedQuantity } from "../lib/pricing";

export async function reservedQuantity(db: Db, equipmentId: string, startDate: string, endDate: string, session?: ClientSession): Promise<number> {
  const interval = { equipmentId, startDate: { $lte: endDate }, endDate: { $gte: startDate } };
  const bookings = await db.collection<Booking>("bookings").find(interval, { session }).project<{ startDate: string; endDate: string; quantity: number }>({ startDate: 1, endDate: 1, quantity: 1 }).toArray();
  const intents = await db.collection<RentalIntent>("rentalIntents").find({ ...interval, status: { $in: ["creating", "open"] } }, { session }).project<{ startDate: string; endDate: string; quantity: number }>({ startDate: 1, endDate: 1, quantity: 1 }).toArray();
  return peakReservedQuantity([...bookings, ...intents], startDate, endDate);
}

export async function lockEquipment(db: Db, id: string, session: ClientSession): Promise<Equipment> {
  const equipment = await db.collection<Equipment>("equipment").findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $inc: { inventoryRevision: 1 } }, { session, returnDocument: "after" });
  if (!equipment) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "This equipment is no longer available.");
  return equipment;
}

export async function availableQuantity(db: Db, equipment: Equipment, startDate: string, endDate: string): Promise<number> {
  return Math.max(0, equipment.quantity - await reservedQuantity(db, equipment._id, startDate, endDate));
}
