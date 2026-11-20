import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRental, peakReservedQuantity } from "../src/lib/pricing";
import { dateNumber } from "../src/lib/dates";
import { equipmentSchema, profileSchema, escapeRegex } from "../src/lib/validation";
import { validatePaidSession } from "../src/services/payments";
import { bookingNotificationDocuments, completionNotificationDocuments, sendEmailNotification } from "../src/services/notifications";
import { rentalHasEnded } from "../src/services/rentals";
import type { Booking, EmailNotification, Env, RentalIntent } from "../src/types";

test("daily billing includes both endpoints and multiplies quantity once", () => {
  assert.deepEqual(calculateRental("2026-11-20", "2026-11-20", "daily", 1250, 3), { durationDays: 1, periods: 1, amountCents: 3750, currency: "USD" });
  assert.equal(calculateRental("2026-11-20", "2026-11-22", "daily", 1250, 2).amountCents, 7500);
});
test("weekly and monthly periods round up at billing boundaries", () => {
  assert.equal(calculateRental("2026-11-20", "2026-11-26", "weekly", 7000, 1).periods, 1);
  assert.equal(calculateRental("2026-11-20", "2026-11-27", "weekly", 7000, 1).periods, 2);
  assert.equal(calculateRental("2026-11-01", "2026-11-30", "monthly", 15000, 1).periods, 1);
  assert.equal(calculateRental("2026-11-01", "2026-12-01", "monthly", 15000, 1).periods, 2);
});
test("invalid calendar dates, past starts, reversed ranges and fractional quantities fail", () => {
  assert.throws(() => dateNumber("2026-02-30"));
  assert.throws(() => calculateRental("2026-11-19", "2026-11-20", "daily", 1000, 1, "2026-11-20"));
  assert.throws(() => calculateRental("2026-11-22", "2026-11-20", "daily", 1000, 1));
  assert.throws(() => calculateRental("2026-11-20", "2026-11-20", "daily", 1000, 1.5));
});
test("availability counts peak simultaneous reservations rather than summing distinct rentals", () => {
  assert.equal(peakReservedQuantity([{ startDate: "2026-11-20", endDate: "2026-11-21", quantity: 2 }, { startDate: "2026-11-22", endDate: "2026-11-23", quantity: 2 }], "2026-11-20", "2026-11-23"), 2);
  assert.equal(peakReservedQuantity([{ startDate: "2026-11-20", endDate: "2026-11-21", quantity: 2 }, { startDate: "2026-11-21", endDate: "2026-11-23", quantity: 3 }], "2026-11-20", "2026-11-23"), 5);
  assert.equal(peakReservedQuantity([{ startDate: "2026-11-18", endDate: "2026-11-19", quantity: 9 }], "2026-11-20", "2026-11-23"), 0);
});
test("profile and equipment validators reject privileged field injection", () => {
  assert.equal(profileSchema.safeParse({ name: "Customer", role: "admin" }).success, false);
  assert.equal(profileSchema.safeParse({ name: "Customer", email: "other@example.com" }).success, false);
  const equipment = { name: "Camera", description: "A professional camera for event coverage.", category: "photography", location: "Dhaka", rentalPriceCents: 2000, rentalType: "daily", quantity: 2, condition: "excellent", image: "https://i.ibb.co/example/camera.jpg", terms: "Return in original working condition." };
  assert.equal(equipmentSchema.safeParse({ ...equipment, ownerId: "another-user" }).success, false);
  assert.equal(equipmentSchema.safeParse({ ...equipment, status: "approved" }).success, false);
  assert.equal(equipmentSchema.safeParse(equipment).success, true);
});
test("search input is treated as literal text rather than executable regex", () => {
  const expression = new RegExp(escapeRegex("camera.*[test]"), "i");
  assert.equal(expression.test("camera.*[test]"), true);
  assert.equal(expression.test("cameraAnythingtest"), false);
});
test("payment fulfillment rejects unpaid, tampered amount, currency and identity", () => {
  const intent = { _id: "intent", customerId: "customer", amountCents: 5000, currency: "USD" } as RentalIntent;
  const checkout = { payment_status: "paid" as const, amount_total: 5000, currency: "usd", client_reference_id: "customer", metadata: { intentId: "intent" } };
  assert.doesNotThrow(() => validatePaidSession(checkout, intent));
  assert.throws(() => validatePaidSession({ ...checkout, payment_status: "unpaid" }, intent));
  assert.throws(() => validatePaidSession({ ...checkout, amount_total: 1 }, intent));
  assert.throws(() => validatePaidSession({ ...checkout, currency: "eur" }, intent));
  assert.throws(() => validatePaidSession({ ...checkout, client_reference_id: "another-customer" }, intent));
});

const completedBooking = {
  _id: "booking-1", intentId: "intent-1", equipmentId: "equipment-1", customerId: "customer-1", ownerId: "owner-1",
  customer: { id: "customer-1", name: "Customer One", email: "customer@example.com", image: null },
  owner: { id: "owner-1", name: "Owner One", email: "owner@example.com", image: null },
  equipment: { id: "equipment-1", name: "Professional Camera", image: "https://example.com/camera.jpg", category: "photography" },
  startDate: "2026-11-18", endDate: "2026-11-20", quantity: 2, contactNumber: "+8801700000000", deliveryAddress: "Dhaka", notes: "",
  rentalType: "daily", rentalPriceCents: 4500, durationDays: 3, periods: 3, amountCents: 27000, currency: "USD",
  checkoutSessionId: "cs_test_booking", paymentIntentId: "pi_test_booking", paymentStatus: "paid", status: "completed",
  createdAt: new Date("2026-11-17T00:00:00Z"), updatedAt: new Date("2026-11-21T00:00:00Z")
} satisfies Booking;

test("rental completion starts only after the inclusive end date", () => {
  assert.equal(rentalHasEnded("2026-11-20", "2026-11-20"), false);
  assert.equal(rentalHasEnded("2026-11-20", "2026-11-21"), true);
});

test("completion creates idempotent customer and owner email notifications", () => {
  const notifications = completionNotificationDocuments(completedBooking, "https://gearnest.sraboni.dev", new Date("2026-11-21T00:00:00Z"));
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((item) => item.recipient), ["customer@example.com", "owner@example.com"]);
  assert.equal(new Set(notifications.map((item) => item._id)).size, 2);
  assert.ok(notifications.every((item) => item.text.includes("Professional Camera") && item.status === "pending"));
});

test("payment confirmation creates customer and owner email notifications", () => {
  const notifications = bookingNotificationDocuments(completedBooking, "https://gearnest.sraboni.dev", new Date("2026-11-21T00:00:00Z"));
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((item) => item.kind), ["booking-confirmed", "booking-confirmed"]);
  assert.ok(notifications[0].subject.includes("booking is confirmed"));
  assert.ok(notifications[1].subject.includes("New paid rental"));
});

test("email delivery uses provider idempotency and server-only authorization", async () => {
  const notification = completionNotificationDocuments(completedBooking, "https://gearnest.sraboni.dev")[0] as EmailNotification;
  const env = { RESEND_API_KEY: "re_test_fixture", EMAIL_FROM: "GearNest <notifications@sraboni.dev>" } as Env;
  const providerId = await sendEmailNotification(env, notification, async (input, init) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer re_test_fixture");
    assert.equal(headers.get("Idempotency-Key"), notification._id);
    const body = JSON.parse(String(init?.body)) as { to: string[]; from: string; subject: string };
    assert.deepEqual(body.to, [notification.recipient]);
    assert.equal(body.from, env.EMAIL_FROM);
    assert.equal(body.subject, notification.subject);
    return Response.json({ id: "email-fixture" });
  });
  assert.equal(providerId, "email-fixture");
});
