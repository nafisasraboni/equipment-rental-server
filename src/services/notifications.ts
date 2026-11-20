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

export function completionNotificationDocuments(booking: Booking, origin: string, now = new Date()): EmailNotification[] {
  const equipmentName = singleLine(booking.equipment.name);
  const amount = money(booking.amountCents, booking.currency);
  const shared = `Equipment: ${equipmentName}\nRental dates: ${booking.startDate} to ${booking.endDate}\nQuantity: ${booking.quantity}\nTotal paid: ${amount}`;
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

export async function enqueueCompletionNotifications(env: Env, db: Db, booking: Booking, session?: ClientSession) {
  const notifications = completionNotificationDocuments(booking, appOrigin(env));
  for (const notification of notifications) {
    await db.collection<EmailNotification>("emailNotifications").updateOne(
      { _id: notification._id }, { $setOnInsert: notification }, { upsert: true, session }
    );
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function sendCompletionNotification(env: Env, notification: EmailNotification, fetcher: Fetcher = fetch) {
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

export async function deliverPendingNotifications(env: Env, db: Db) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: 0, failed: 0, configured: false };
  const collection = db.collection<EmailNotification>("emailNotifications");
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < 25; index++) {
    const now = new Date();
    const filter: Filter<EmailNotification> = {
      attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now },
      $or: [{ status: { $in: ["pending", "failed"] } }, { status: "sending", leaseUntil: { $lte: now } }]
    };
    const notification = await collection.findOneAndUpdate(filter, {
      $set: { status: "sending", leaseUntil: new Date(now.getTime() + 5 * 60_000), updatedAt: now }, $inc: { attempts: 1 }
    }, { sort: { createdAt: 1 }, returnDocument: "after" });
    if (!notification) break;
    try {
      const providerId = await sendCompletionNotification(env, notification);
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
