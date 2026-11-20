import Stripe from "stripe";
import type { Db, Filter, MongoClient } from "mongodb";
import type { Booking, Env, Equipment, Payment, RentalInput, RentalIntent, User } from "../types";
import { ApiError } from "../lib/errors";
import { calculateRental } from "../lib/pricing";
import { today } from "../lib/dates";
import { person } from "../lib/serialize";
import { lockEquipment, reservedQuantity } from "./inventory";
import { enqueueBookingNotifications } from "./notifications";

export function stripeClient(env: Env) {
  if (!/^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) throw new ApiError(503, "PAYMENTS_UNAVAILABLE", "Sandbox payments are not configured yet.");
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 12_000 });
}

export function validatePaidSession(session: Pick<Stripe.Checkout.Session, "payment_status" | "amount_total" | "currency" | "client_reference_id" | "metadata">, intent: RentalIntent) {
  if (session.payment_status !== "paid") throw new ApiError(409, "PAYMENT_NOT_COMPLETE", "Payment has not completed yet.");
  if (session.amount_total !== intent.amountCents || session.currency?.toUpperCase() !== intent.currency || session.client_reference_id !== intent.customerId || session.metadata?.intentId !== intent._id) throw new ApiError(409, "PAYMENT_MISMATCH", "The payment does not match the verified rental reservation.");
}

export type PaymentCheckout = Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "amount_total" | "currency" | "client_reference_id" | "payment_intent">;

export async function finalizeCheckout(env: Env, db: Db, client: MongoClient, checkout: PaymentCheckout): Promise<Booking> {
  const intentId = checkout.metadata?.intentId;
  if (!intentId) throw new ApiError(400, "INVALID_PAYMENT", "Rental reservation information is missing.");
  const intent = await db.collection<RentalIntent>("rentalIntents").findOne({ _id: intentId });
  if (!intent) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Rental reservation not found.");
  validatePaidSession(checkout, intent);
  if (intent.checkoutSessionId && intent.checkoutSessionId !== checkout.id) throw new ApiError(409, "PAYMENT_MISMATCH", "This checkout belongs to another reservation.");
  const paymentIntentId = typeof checkout.payment_intent === "string" ? checkout.payment_intent : checkout.payment_intent?.id ?? null;
  const now = new Date();
  const booking: Booking = {
    _id: intent._id, intentId: intent._id, equipmentId: intent.equipmentId, customerId: intent.customerId, ownerId: intent.ownerId,
    customer: intent.customer, owner: intent.owner, equipment: intent.equipment,
    startDate: intent.startDate, endDate: intent.endDate, quantity: intent.quantity, contactNumber: intent.contactNumber, deliveryAddress: intent.deliveryAddress, notes: intent.notes,
    rentalType: intent.rentalType, rentalPriceCents: intent.rentalPriceCents, durationDays: intent.durationDays, periods: intent.periods, amountCents: intent.amountCents, currency: intent.currency,
    checkoutSessionId: checkout.id, paymentIntentId, paymentStatus: "paid", status: "confirmed",
    bookingNotificationsQueuedAt: now, createdAt: now, updatedAt: now
  };
  const session = client.startSession();
  let result = booking;
  try {
    await session.withTransaction(async () => {
      const existing = await db.collection<Booking>("bookings").findOne({ intentId: intent._id }, { session });
      if (existing) {
        result = existing;
        if (!existing.bookingNotificationsQueuedAt) {
          await enqueueBookingNotifications(env, db, existing, session);
          const queuedAt = new Date();
          await db.collection<Booking>("bookings").updateOne(
            { _id: existing._id }, { $set: { bookingNotificationsQueuedAt: queuedAt, updatedAt: queuedAt } }, { session }
          );
          result = { ...existing, bookingNotificationsQueuedAt: queuedAt, updatedAt: queuedAt };
        }
        return;
      }
      const current = await db.collection<RentalIntent>("rentalIntents").findOne({ _id: intent._id }, { session });
      if (!current) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Rental reservation not found.");
      if (current.status === "failed" || current.status === "expired") throw new ApiError(409, "RESERVATION_RELEASED", "This reservation has already been released.");
      await db.collection<Equipment>("equipment").updateOne({ _id: current.equipmentId }, { $inc: { inventoryRevision: 1 } }, { session });
      await db.collection<Booking>("bookings").insertOne(booking, { session });
      await enqueueBookingNotifications(env, db, booking, session);
      const payment: Payment = { _id: checkout.id, bookingId: booking._id, customerId: intent.customerId, ownerId: intent.ownerId, equipmentId: intent.equipmentId, checkoutSessionId: checkout.id, paymentIntentId, amountCents: intent.amountCents, currency: intent.currency, status: "paid", createdAt: now };
      await db.collection<Payment>("payments").insertOne(payment, { session });
      await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id }, { $set: { status: "consumed", checkoutSessionId: checkout.id } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
  } finally { await session.endSession(); }
  return result;
}

async function createStripeSession(env: Env, intent: RentalIntent): Promise<Stripe.Checkout.Session> {
  const origin = env.CLIENT_ORIGIN.split(",")[0].replace(/\/$/, "");
  return stripeClient(env).checkout.sessions.create({
    mode: "payment", allowed_payment_method_types: ["card"], adaptive_pricing: { enabled: false }, customer_email: intent.customer.email,
    client_reference_id: intent.customerId, metadata: { intentId: intent._id, customerId: intent.customerId, ownerId: intent.ownerId },
    line_items: [{ quantity: intent.quantity, price_data: { currency: "usd", unit_amount: intent.rentalPriceCents * intent.periods, product_data: { name: intent.equipment.name, description: `${intent.startDate} to ${intent.endDate} · ${intent.durationDays} days · ${intent.periods} ${intent.rentalType} period(s)` } } }],
    success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment/cancel?intentId=${intent._id}`,
    expires_at: Math.floor(intent.expiresAt.getTime() / 1000)
  }, { idempotencyKey: `rental-${intent._id}` });
}

function definiteCreationFailure(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError || error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError;
}

export async function ensureCheckout(env: Env, db: Db, intent: RentalIntent) {
  if (intent.status === "consumed") throw new ApiError(409, "ALREADY_BOOKED", "This reservation has already been paid.");
  if (intent.status === "expired" || intent.status === "failed") throw new ApiError(409, "RESERVATION_EXPIRED", "This checkout expired. Please create a new booking.");
  if (intent.checkoutSessionId) {
    const checkout = await stripeClient(env).checkout.sessions.retrieve(intent.checkoutSessionId);
    if (checkout.status === "expired") throw new ApiError(409, "RESERVATION_EXPIRED", "This checkout expired. Please create a new booking.");
    if (checkout.payment_status === "paid") throw new ApiError(409, "ALREADY_BOOKED", "This reservation has already been paid.");
    return { url: checkout.url ?? intent.checkoutUrl, intentId: intent._id, sessionId: checkout.id };
  }
  try {
    const checkout = await createStripeSession(env, intent);
    if (!checkout.url) throw new ApiError(503, "CHECKOUT_UNAVAILABLE", "Checkout is temporarily unavailable.");
    await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id, status: "creating" }, { $set: { status: "open", checkoutSessionId: checkout.id, checkoutUrl: checkout.url } });
    return { url: checkout.url, intentId: intent._id, sessionId: checkout.id };
  } catch (error) {
    if (definiteCreationFailure(error)) await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id, status: "creating" }, { $set: { status: "failed" } });
    if (error instanceof ApiError) throw error;
    console.error("Stripe Checkout creation failed", { type: error instanceof Error ? error.name : "UnknownError", intentId: intent._id });
    throw new ApiError(503, "CHECKOUT_UNAVAILABLE", "Checkout could not be opened. Retry this booking safely using the same request.");
  }
}

export async function reconcileIntents(env: Env, db: Db, client: MongoClient, equipmentId?: string) {
  const filter: Filter<RentalIntent> = { status: { $in: ["creating", "open"] }, expiresAt: { $lte: new Date() }, ...(equipmentId ? { equipmentId } : {}) };
  const intents = await db.collection<RentalIntent>("rentalIntents").find(filter).limit(25).toArray();
  for (const intent of intents) {
    try {
      const checkout = intent.checkoutSessionId ? await stripeClient(env).checkout.sessions.retrieve(intent.checkoutSessionId) : await createStripeSession(env, intent);
      if (checkout.payment_status === "paid") await finalizeCheckout(env, db, client, checkout);
      else if (checkout.status === "expired") await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id, status: { $in: ["creating", "open"] } }, { $set: { status: "expired", checkoutSessionId: checkout.id } });
      else if (!intent.checkoutSessionId) await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id, status: "creating" }, { $set: { status: "open", checkoutSessionId: checkout.id, ...(checkout.url ? { checkoutUrl: checkout.url } : {}) } });
    } catch (error) {
      if (!intent.checkoutSessionId && error instanceof Stripe.errors.StripeInvalidRequestError) await db.collection<RentalIntent>("rentalIntents").updateOne({ _id: intent._id, status: "creating" }, { $set: { status: "failed" } });
      else console.error("Checkout reconciliation deferred", { intentId: intent._id, type: error instanceof Error ? error.name : "UnknownError" });
    }
  }
}

export async function reserveRental(env: Env, db: Db, client: MongoClient, user: User, input: RentalInput, requestId: string) {
  const previous = await db.collection<RentalIntent>("rentalIntents").findOne({ customerId: user._id, requestId });
  if (previous) {
    if (previous.equipmentId !== input.equipmentId || previous.startDate !== input.startDate || previous.endDate !== input.endDate || previous.quantity !== input.quantity) throw new ApiError(409, "REQUEST_ID_REUSED", "This request identifier belongs to a different rental.");
    return previous;
  }
  await reconcileIntents(env, db, client, input.equipmentId);
  const session = client.startSession();
  let intent: RentalIntent | undefined;
  try {
    await session.withTransaction(async () => {
      const previousInside = await db.collection<RentalIntent>("rentalIntents").findOne({ customerId: user._id, requestId }, { session });
      if (previousInside) { intent = previousInside; return; }
      const equipment = await lockEquipment(db, input.equipmentId, session);
      if (equipment.status !== "approved") throw new ApiError(409, "EQUIPMENT_NOT_APPROVED", "This equipment is not available for new rentals.");
      const price = calculateRental(input.startDate, input.endDate, equipment.rentalType, equipment.rentalPriceCents, input.quantity, today());
      if (input.quantity > equipment.quantity - await reservedQuantity(db, equipment._id, input.startDate, input.endDate, session)) throw new ApiError(409, "INSUFFICIENT_AVAILABILITY", "The selected quantity is unavailable for these dates.");
      const owner = await db.collection<User>("users").findOne({ _id: equipment.ownerId }, { session });
      if (!owner || owner.status === "suspended") throw new ApiError(409, "OWNER_UNAVAILABLE", "This owner's equipment is currently unavailable.");
      const now = new Date();
      intent = { ...input, ...price, _id: crypto.randomUUID(), requestId, customerId: user._id, ownerId: equipment.ownerId, customer: person(user), owner: person(owner), equipment: { id: equipment._id, name: equipment.name, image: equipment.image, category: equipment.category }, rentalType: equipment.rentalType, rentalPriceCents: equipment.rentalPriceCents, status: "creating", createdAt: now, expiresAt: new Date(now.getTime() + 35 * 60_000) };
      await db.collection<RentalIntent>("rentalIntents").insertOne(intent, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
  } finally { await session.endSession(); }
  if (!intent) throw new ApiError(503, "RESERVATION_UNAVAILABLE", "The reservation could not be created. Please retry.");
  return intent;
}
