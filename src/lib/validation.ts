import { z } from "zod";

export const idSchema = z.string().uuid();
export const categories = ["construction", "photography", "transportation", "agriculture", "electronics", "events"] as const;
export const imageSchema = z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an HTTPS image URL.");
export const equipmentSchema = z.object({
  name: z.string().trim().min(3).max(150),
  description: z.string().trim().min(20).max(6000),
  category: z.enum(categories),
  location: z.string().trim().min(2).max(150),
  rentalPriceCents: z.number().int().min(50).max(10_000_000),
  rentalType: z.enum(["daily", "weekly", "monthly"]),
  quantity: z.number().int().min(1).max(10_000),
  condition: z.string().trim().min(2).max(80),
  brand: z.string().trim().max(100).default(""),
  model: z.string().trim().max(100).default(""),
  image: imageSchema,
  terms: z.string().trim().min(10).max(4000)
}).strict();

export const rentalSchema = z.object({
  equipmentId: idSchema,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.number().int().min(1).max(10_000),
  contactNumber: z.string().trim().min(6).max(30).regex(/^[+\d\s()-]+$/),
  deliveryAddress: z.string().trim().min(5).max(500),
  notes: z.string().trim().max(2000).default("")
}).strict();

export const quoteSchema = rentalSchema.pick({ equipmentId: true, startDate: true, endDate: true, quantity: true });
export const checkoutSchema = rentalSchema.extend({ requestId: z.string().uuid() });
export const profileSchema = z.object({ name: z.string().trim().min(2).max(100).optional(), image: imageSchema.optional(), phone: z.string().trim().max(30).optional(), address: z.string().trim().max(500).optional() }).strict().refine((value) => Object.keys(value).length > 0, "Choose at least one profile field to update.");

export const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(12) });
export const catalogSchema = pageSchema.extend({
  search: z.string().trim().max(100).default(""),
  category: z.enum(categories).optional(),
  rentalType: z.enum(["daily", "weekly", "monthly"]).optional(),
  minPrice: z.coerce.number().nonnegative().max(100_000).optional(),
  maxPrice: z.coerce.number().nonnegative().max(100_000).optional(),
  availability: z.enum(["available", "unavailable", "all"]).default("all"),
  sort: z.enum(["price_asc", "price_desc", "recent"]).default("recent")
}).refine((value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, "Minimum price cannot exceed maximum price.");

export function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function cleanQuery(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([key, value]) => value !== "" && !(value === "all" && ["category", "rentalType", "status", "role"].includes(key))));
}
