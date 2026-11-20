import type { Db, MongoClient } from "mongodb";

export type Role = "customer" | "owner" | "admin";
export type RentalType = "daily" | "weekly" | "monthly";
export type EquipmentStatus = "pending" | "approved" | "rejected";
export type Category = "construction" | "photography" | "transportation" | "agriculture" | "electronics" | "events";

export interface Env {
  MONGODB_URI: string;
  MONGODB_DB?: string;
  CLIENT_ORIGIN: string;
  AUTH_ISSUER: string;
  JWT_AUDIENCE: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  IMGBB_API_KEY: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  CURRENCY?: string;
}

export interface User {
  _id: string;
  name: string;
  email: string;
  image?: string | null;
  role: Role;
  status: "active" | "suspended";
  phone?: string;
  address?: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Equipment {
  _id: string;
  ownerId: string;
  name: string;
  description: string;
  category: Category;
  location: string;
  rentalPriceCents: number;
  rentalType: RentalType;
  quantity: number;
  condition: string;
  brand: string;
  model: string;
  image: string;
  terms: string;
  status: EquipmentStatus;
  rejectionReason?: string;
  inventoryRevision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface PersonSnapshot {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface RentalInput {
  equipmentId: string;
  startDate: string;
  endDate: string;
  quantity: number;
  contactNumber: string;
  deliveryAddress: string;
  notes: string;
}

export interface RentalIntent extends RentalInput {
  _id: string;
  requestId: string;
  customerId: string;
  ownerId: string;
  customer: PersonSnapshot;
  owner: PersonSnapshot;
  equipment: { id: string; name: string; image: string; category: Category };
  rentalType: RentalType;
  rentalPriceCents: number;
  durationDays: number;
  periods: number;
  amountCents: number;
  currency: "USD";
  status: "creating" | "open" | "consumed" | "expired" | "failed";
  checkoutSessionId?: string;
  checkoutUrl?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface Booking extends RentalInput {
  _id: string;
  intentId: string;
  customerId: string;
  ownerId: string;
  customer: PersonSnapshot;
  owner: PersonSnapshot;
  equipment: RentalIntent["equipment"];
  rentalType: RentalType;
  rentalPriceCents: number;
  durationDays: number;
  periods: number;
  amountCents: number;
  currency: "USD";
  checkoutSessionId: string;
  paymentIntentId: string | null;
  paymentStatus: "paid";
  status: "confirmed" | "completed";
  bookingNotificationsQueuedAt?: Date;
  completedAt?: Date;
  completionNotificationsQueuedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailNotification {
  _id: string;
  bookingId: string;
  kind: "booking-confirmed" | "rental-completed";
  audience: "customer" | "owner";
  recipient: string;
  subject: string;
  text: string;
  status: "pending" | "sending" | "failed" | "sent";
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date;
  sentAt?: Date;
  providerId?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Payment {
  _id: string;
  bookingId: string;
  customerId: string;
  ownerId: string;
  equipmentId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: "USD";
  status: "paid";
  createdAt: Date;
}

export interface RequestContext {
  env: Env;
  client: MongoClient;
  db: Db;
}

declare global {
  namespace Express {
    interface Request {
      context: RequestContext;
      user: User;
    }
  }
}
