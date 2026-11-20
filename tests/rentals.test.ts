import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRental, peakReservedQuantity } from "../src/lib/pricing";
import { dateNumber } from "../src/lib/dates";
import { equipmentSchema, profileSchema, escapeRegex } from "../src/lib/validation";
import { validatePaidSession } from "../src/services/payments";
import type { RentalIntent } from "../src/types";

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
