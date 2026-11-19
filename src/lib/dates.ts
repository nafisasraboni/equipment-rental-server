import { ApiError } from "./errors";

const DAY_MS = 86_400_000;

export function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "INVALID_DATE", "Use dates in YYYY-MM-DD format.");
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new ApiError(400, "INVALID_DATE", "Select a valid calendar date.");
  return timestamp / DAY_MS;
}

export function today(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function rentalDays(startDate: string, endDate: string, minimumDate?: string): number {
  const start = dateNumber(startDate);
  const end = dateNumber(endDate);
  if (end < start) throw new ApiError(400, "INVALID_DATE_RANGE", "The end date must be on or after the start date.");
  if (minimumDate && start < dateNumber(minimumDate)) throw new ApiError(400, "PAST_RENTAL_DATE", "A rental cannot start in the past.");
  return end - start + 1;
}
