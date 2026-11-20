import type { ClientSession, Db, Filter } from "mongodb";
import type { Booking, EmailNotification, Env } from "../types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_ATTEMPTS = 8;

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function money(amountCents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
}

function appOrigin(env: Env) {
  return env.CLIENT_ORIGIN.split(",")[0].trim().replace(/\/$/, "");
}

function bookingDetails(booking: Booking) {
  return `Equipment: ${singleLine(booking.equipment.name)}\nRental dates: ${booking.startDate} to ${booking.endDate}\nQuantity: ${booking.quantity}\nTotal paid: ${money(booking.amountCents, booking.currency)}`;
}

export function bookingNotificationDocuments(booking: Booking, origin: string, now = new Date()): EmailNotification[] {
  const equipmentName = singleLine(booking.equipment.name);
  const shared = bookingDetails(booking);
  return [
    {
      _id: `${booking._id}:booking-confirmed:customer`, bookingId: booking._id, kind: "booking-confirmed", audience: "customer",
      recipient: booking.customer.email, subject: `Your GearNest booking is confirmed — ${equipmentName}`,
      text: `Hi ${singleLine(booking.customer.name)},\n\nYour payment was successful and your GearNest booking is confirmed.\n\n${shared}\n\nView your rental history: ${origin}/dashboard/customer/rentals\n\nThank you for renting with GearNest.`,
      status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now
    },
    {
      _id: `${booking._id}:booking-confirmed:owner`, bookingId: booking._id, kind: "booking-confirmed", audience: "owner",
      recipient: booking.owner.email, subject: `New paid rental for ${equipmentName}`,
      text: `Hi ${singleLine(booking.owner.name)},\n\nA customer completed payment for your equipment.\n\nCustomer: ${singleLine(booking.customer.name)}\n${shared}\n\nView your rental records: ${origin}/dashboard/owner/rentals\n\nGearNest`,
      status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now
    }
  ];
}

export function completionNotificationDocuments(booking: Booking, origin: string, now = new Date()): EmailNotification[] {
  const equipmentName = singleLine(booking.equipment.name);
  const shared = bookingDetails(booking);
  return [
    {
      _id: `${booking._id}:rental-completed:customer`, bookingId: booking._id, kind: "rental-completed", audience: "customer",
      recipient: booking.customer.email, subject: `Your GearNest rental is complete — ${equipmentName}`,
      text: `Hi ${singleLine(booking.customer.name)},\n\nYour GearNest rental is now complete.\n\n${shared}\n\nView your rental history: ${origin}/dashboard/customer/rentals\n\nThank you for renting with GearNest.`,
      status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now
    },
    {
      _id: `${booking._id}:rental-completed:owner`, bookingId: booking._id, kind: "rental-completed", audience: "owner",
      recipient: booking.owner.email, subject: `Rental completed for ${equipmentName}`,
      text: `Hi ${singleLine(booking.owner.name)},\n\nA rental for your equipment is now complete.\n\nCustomer: ${singleLine(booking.customer.name)}\n${shared}\n\nView your rental records: ${origin}/dashboard/owner/rentals\n\nGearNest`,
      status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now
    }
  ];
}

async function enqueueNotifications(db: Db, notifications: EmailNotification[], session?: ClientSession) {
  for (const notification of notifications) {
    await db.collection<EmailNotification>("emailNotifications").updateOne(
      { _id: notification._id }, { $setOnInsert: notification }, { upsert: true, session }
    );
  }
}

export async function enqueueBookingNotifications(env: Env, db: Db, booking: Booking, session?: ClientSession) {
  await enqueueNotifications(db, bookingNotificationDocuments(booking, appOrigin(env)), session);
}

export async function enqueueCompletionNotifications(env: Env, db: Db, booking: Booking, session?: ClientSession) {
  await enqueueNotifications(db, completionNotificationDocuments(booking, appOrigin(env)), session);
}

export async function queueExistingBookingNotifications(env: Env, db: Db) {
  const bookings = await db.collection<Booking>("bookings").find({
    paymentStatus: "paid", bookingNotificationsQueuedAt: { $exists: false }
  }).sort({ createdAt: 1 }).limit(50).toArray();
  let queued = 0;
  for (const booking of bookings) {
    await enqueueBookingNotifications(env, db, booking);
    const queuedAt = new Date();
    const result = await db.collection<Booking>("bookings").updateOne(
      { _id: booking._id, bookingNotificationsQueuedAt: { $exists: false } },
      { $set: { bookingNotificationsQueuedAt: queuedAt, updatedAt: queuedAt } }
    );
    queued += result.modifiedCount;
  }
  return queued;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function sendEmailNotification(env: Env, notification: EmailNotification, fetcher: Fetcher = fetch) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("Email delivery is not configured.");
  const response = await fetcher(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": notification._id
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [notification.recipient], subject: notification.subject, text: notification.text })
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
  const body = await response.json().catch(() => ({})) as { id?: string };
  return body.id;
}

export async function deliverPendingNotifications(env: Env, db: Db, bookingId?: string) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: 0, failed: 0, configured: false };
  const collection = db.collection<EmailNotification>("emailNotifications");
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < 25; index++) {
    const now = new Date();
    const filter: Filter<EmailNotification> = {
      ...(bookingId ? { bookingId } : {}),
      attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now },
      $or: [{ status: { $in: ["pending", "failed"] } }, { status: "sending", leaseUntil: { $lte: now } }]
    };
    const notification = await collection.findOneAndUpdate(filter, {
      $set: { status: "sending", leaseUntil: new Date(now.getTime() + 5 * 60_000), updatedAt: now }, $inc: { attempts: 1 }
    }, { sort: { createdAt: 1 }, returnDocument: "after" });
    if (!notification) break;
    try {
      const providerId = await sendEmailNotification(env, notification);
      await collection.updateOne({ _id: notification._id, status: "sending" }, {
        $set: { status: "sent", sentAt: new Date(), updatedAt: new Date(), ...(providerId ? { providerId } : {}) },
        $unset: { leaseUntil: "", lastError: "" }
      });
      sent++;
    } catch (error) {
      const delayMinutes = Math.min(360, 5 * 2 ** Math.max(0, notification.attempts - 1));
      await collection.updateOne({ _id: notification._id, status: "sending" }, {
        $set: {
          status: "failed", updatedAt: new Date(), nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
          lastError: (error instanceof Error ? error.message : "Email delivery failed.").slice(0, 300)
        },
        $unset: { leaseUntil: "" }
      });
      failed++;
    }
  }
  return { sent, failed, configured: true };
}
