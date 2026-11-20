import { Router, raw } from "express";
import { z } from "zod";
import type { Filter } from "mongodb";
import type { Booking, Equipment, RentalIntent } from "../types";
import { verifyToken, verifyRenter, verifyOwner, verifyAdmin } from "../middleware/auth";
import { ApiError, success } from "../lib/errors";
import { checkoutSchema, cleanQuery, idSchema, pageSchema, quoteSchema } from "../lib/validation";
import { today } from "../lib/dates";
import { calculateRental } from "../lib/pricing";
import { bookingDto, paginated } from "../lib/serialize";
import { availableQuantity } from "../services/inventory";
import { ensureCheckout, finalizeCheckout, reconcileIntents, reserveRental, stripeClient } from "../services/payments";
import { completeBooking } from "../services/rentals";

export function stripeWebhookRoutes() {
  const router = Router();
  router.post("/webhooks/stripe", raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    const signature = req.get("stripe-signature");
    if (!signature || !req.context.env.STRIPE_WEBHOOK_SECRET) throw new ApiError(400, "INVALID_WEBHOOK", "Webhook signature is missing.");
    let event;
    try {
      event = await stripeClient(req.context.env).webhooks.constructEventAsync(req.body, signature, req.context.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      console.error("Stripe signature verification failed", { type: error instanceof Error ? error.name : "UnknownError" });
      throw new ApiError(400, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed.");
    }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (event.data.object.payment_status === "paid") await finalizeCheckout(req.context.db, req.context.client, event.data.object);
    } else if (event.type === "checkout.session.expired") {
      const checkout = await stripeClient(req.context.env).checkout.sessions.retrieve(event.data.object.id);
      if (checkout.payment_status === "paid") await finalizeCheckout(req.context.db, req.context.client, checkout);
      else if (checkout.status === "expired" && checkout.metadata?.intentId) await req.context.db.collection<RentalIntent>("rentalIntents").updateOne({ _id: checkout.metadata.intentId, checkoutSessionId: checkout.id, status: { $in: ["creating", "open"] } }, { $set: { status: "expired" } });
    }
    success(res, { received: true });
  });
  return router;
}

export function bookingRoutes() {
  const router = Router();
  router.post("/bookings/quote", verifyToken, verifyRenter, async (req, res) => {
    const input = quoteSchema.parse(req.body);
    const equipment = await req.context.db.collection<Equipment>("equipment").findOne({ _id: input.equipmentId, status: "approved", deletedAt: { $exists: false } });
    if (!equipment) throw new ApiError(404, "EQUIPMENT_NOT_FOUND", "This equipment is not available for rental.");
    const price = calculateRental(input.startDate, input.endDate, equipment.rentalType, equipment.rentalPriceCents, input.quantity, today());
    await reconcileIntents(req.context.env, req.context.db, req.context.client, input.equipmentId);
    const available = await availableQuantity(req.context.db, equipment, input.startDate, input.endDate);
    if (input.quantity > available) throw new ApiError(409, "INSUFFICIENT_AVAILABILITY", "The selected quantity is unavailable for these dates.");
    success(res, { totalAmountCents: price.amountCents, days: price.durationDays, periods: price.periods, quantity: input.quantity, currency: price.currency, availableQuantity: available });
  });
  router.post("/bookings/checkout", verifyToken, verifyRenter, async (req, res) => {
    const { requestId, ...input } = checkoutSchema.parse(req.body);
    stripeClient(req.context.env);
    const intent = await reserveRental(req.context.env, req.context.db, req.context.client, req.user, input, requestId);
    success(res, await ensureCheckout(req.context.env, req.context.db, intent), 201);
  });
  router.get("/bookings/verify", verifyToken, verifyRenter, async (req, res) => {
    const sessionId = z.string().regex(/^cs_test_[A-Za-z0-9]+$/).parse(req.query.sessionId);
    const checkout = await stripeClient(req.context.env).checkout.sessions.retrieve(sessionId);
    if (checkout.client_reference_id !== req.user._id) throw new ApiError(403, "FORBIDDEN", "This payment belongs to another customer.");
    const booking = checkout.payment_status === "paid" ? await finalizeCheckout(req.context.db, req.context.client, checkout) : null;
    success(res, { booking: booking ? bookingDto(booking) : null, paymentStatus: checkout.payment_status, status: checkout.status });
  });
  const rentalList = (role: "customer" | "owner" | "admin") => async (req: Parameters<typeof verifyToken>[0], res: Parameters<typeof verifyToken>[1]) => {
    const query = pageSchema.parse(cleanQuery(req.query));
    const filter: Filter<Booking> = role === "customer" ? { customerId: req.user._id } : role === "owner" ? { ownerId: req.user._id } : {};
    const [bookings, total] = await Promise.all([req.context.db.collection<Booking>("bookings").find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray(), req.context.db.collection<Booking>("bookings").countDocuments(filter)]);
    success(res, paginated(bookings.map(bookingDto), query.page, query.limit, total));
  };
  router.get("/customer/bookings", verifyToken, verifyRenter, rentalList("customer"));
  router.get("/owner/bookings", verifyToken, verifyOwner, rentalList("owner"));
  router.get("/admin/bookings", verifyToken, verifyAdmin, rentalList("admin"));
  router.patch("/admin/bookings/:id", verifyToken, verifyAdmin, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    z.object({ status: z.literal("completed") }).strict().parse(req.body);
    success(res, bookingDto(await completeBooking(req.context.env, req.context.db, req.context.client, id)));
  });
  return router;
}
