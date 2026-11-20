import type { Db, MongoClient } from "mongodb";
import type { Booking, Env } from "../types";
import { today } from "../lib/dates";
import { ApiError } from "../lib/errors";
import { enqueueCompletionNotifications } from "./notifications";

export function rentalHasEnded(endDate: string, day = today()) {
  return endDate < day;
}

export async function completeBooking(env: Env, db: Db, client: MongoClient, bookingId: string, day = today()) {
  const session = client.startSession();
  try {
    const completed = await session.withTransaction(async () => {
      const current = await db.collection<Booking>("bookings").findOne({ _id: bookingId }, { session });
      if (!current) throw new ApiError(404, "BOOKING_NOT_FOUND", "Booking not found.");
      if (!rentalHasEnded(current.endDate, day)) throw new ApiError(409, "RENTAL_NOT_FINISHED", "A rental can be completed after its end date has passed.");
      let result = current.status === "completed" ? current : await db.collection<Booking>("bookings").findOneAndUpdate(
        { _id: bookingId, status: "confirmed" },
        { $set: { status: "completed", completedAt: new Date(), updatedAt: new Date() } },
        { session, returnDocument: "after" }
      );
      if (!result) throw new ApiError(409, "BOOKING_STATUS_CHANGED", "The rental status changed. Please retry.");
      if (!result.completionNotificationsQueuedAt) {
        await enqueueCompletionNotifications(env, db, result, session);
        const queuedAt = new Date();
        await db.collection<Booking>("bookings").updateOne({ _id: bookingId }, { $set: { completionNotificationsQueuedAt: queuedAt, updatedAt: queuedAt } }, { session });
        result = { ...result, completionNotificationsQueuedAt: queuedAt, updatedAt: queuedAt };
      }
      return result;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
    if (!completed) throw new ApiError(503, "COMPLETION_UNAVAILABLE", "The rental could not be completed. Please retry.");
    return completed;
  } finally { await session.endSession(); }
}

export async function completeEndedRentals(env: Env, db: Db, client: MongoClient, day = today()) {
  const due = await db.collection<Booking>("bookings").find({ status: "confirmed", endDate: { $lt: day } }).sort({ endDate: 1 }).limit(50).project<{ _id: string }>({ _id: 1 }).toArray();
  let completed = 0;
  for (const booking of due) {
    try {
      await completeBooking(env, db, client, booking._id, day);
      completed++;
    } catch (error) {
      console.error("Automatic rental completion deferred", { bookingId: booking._id, type: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  return completed;
}

export async function queueExistingCompletionNotifications(env: Env, db: Db, client: MongoClient, day = today()) {
  const missing = await db.collection<Booking>("bookings").find({ status: "completed", completionNotificationsQueuedAt: { $exists: false }, endDate: { $lt: day } }).sort({ updatedAt: 1 }).limit(50).project<{ _id: string }>({ _id: 1 }).toArray();
  let queued = 0;
  for (const booking of missing) {
    try {
      await completeBooking(env, db, client, booking._id, day);
      queued++;
    } catch (error) {
      console.error("Completion notification queueing deferred", { bookingId: booking._id, type: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  return queued;
}
