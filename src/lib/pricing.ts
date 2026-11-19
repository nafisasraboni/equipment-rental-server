import type { RentalType } from "../types";
import { dateNumber, rentalDays } from "./dates";
import { ApiError } from "./errors";

export function calculateRental(startDate: string, endDate: string, type: RentalType, priceCents: number, quantity: number, minimumDate?: string) {
  if (!Number.isSafeInteger(priceCents) || priceCents < 50 || !Number.isSafeInteger(quantity) || quantity < 1) throw new ApiError(400, "INVALID_RENTAL", "Rental price and quantity must be valid positive amounts.");
  const durationDays = rentalDays(startDate, endDate, minimumDate);
  const periods = Math.ceil(durationDays / (type === "weekly" ? 7 : type === "monthly" ? 30 : 1));
  const amountCents = periods * priceCents * quantity;
  if (!Number.isSafeInteger(amountCents) || amountCents > 99_999_999) throw new ApiError(400, "RENTAL_AMOUNT_TOO_LARGE", "This rental exceeds the supported payment amount.");
  return { durationDays, periods, amountCents, currency: "USD" as const };
}

export interface Reservation { startDate: string; endDate: string; quantity: number }

export function peakReservedQuantity(reservations: Reservation[], startDate: string, endDate: string): number {
  const start = dateNumber(startDate);
  const end = dateNumber(endDate);
  const changes = new Map<number, number>();
  for (const reservation of reservations) {
    const left = Math.max(start, dateNumber(reservation.startDate));
    const right = Math.min(end, dateNumber(reservation.endDate));
    if (left > right) continue;
    changes.set(left, (changes.get(left) ?? 0) + reservation.quantity);
    changes.set(right + 1, (changes.get(right + 1) ?? 0) - reservation.quantity);
  }
  let active = 0;
  let peak = 0;
  for (const [, change] of [...changes.entries()].sort((a, b) => a[0] - b[0])) {
    active += change;
    peak = Math.max(peak, active);
  }
  return peak;
}
