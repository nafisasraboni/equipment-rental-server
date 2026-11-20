import { MongoClient, type Db } from "mongodb";
import type { Booking, EmailNotification, Env, Equipment, RentalIntent, User } from "../types";

export async function withDatabase<T>(env: Env, operation: (db: Db, client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: 7000, connectTimeoutMS: 7000, socketTimeoutMS: 20_000 });
  try {
    await client.connect();
    return await operation(client.db(env.MONGODB_DB ?? "gearnest"), client);
  } finally {
    await client.close();
  }
}

export async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection<Equipment>("equipment").createIndex({ status: 1, deletedAt: 1, category: 1, rentalPriceCents: 1 }),
    db.collection<Equipment>("equipment").createIndex({ ownerId: 1, createdAt: -1 }),
    db.collection<Booking>("bookings").createIndex({ equipmentId: 1, startDate: 1, endDate: 1 }),
    db.collection<Booking>("bookings").createIndex({ customerId: 1, createdAt: -1 }),
    db.collection<Booking>("bookings").createIndex({ ownerId: 1, createdAt: -1 }),
    db.collection<Booking>("bookings").createIndex({ status: 1, endDate: 1, completionNotificationsQueuedAt: 1 }),
    db.collection<Booking>("bookings").createIndex({ intentId: 1 }, { unique: true }),
    db.collection<Booking>("bookings").createIndex({ checkoutSessionId: 1 }, { unique: true }),
    db.collection<RentalIntent>("rentalIntents").createIndex({ customerId: 1, requestId: 1 }, { unique: true }),
    db.collection<RentalIntent>("rentalIntents").createIndex({ equipmentId: 1, status: 1, endDate: 1 }),
    db.collection("payments").createIndex({ checkoutSessionId: 1 }, { unique: true }),
    db.collection("payments").createIndex({ ownerId: 1, createdAt: 1 }),
    db.collection<EmailNotification>("emailNotifications").createIndex({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    db.collection("favorites").createIndex({ customerId: 1, equipmentId: 1 }, { unique: true }),
    db.collection<User>("users").createIndex({ role: 1, status: 1 }),
    db.collection<User>("users").createIndex({ email: 1 }, { unique: true, name: "users_email_uidx" }),
    db.collection("account").createIndex({ providerId: 1, accountId: 1 }, { unique: true, name: "account_provider_account_uidx" }),
    db.collection("session").createIndex({ token: 1 }, { unique: true, name: "session_token_uidx" }),
    db.collection("session").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "session_expiry_ttl" })
  ]);
  await db.collection<{ _id: string; revision: number }>("system").updateOne({ _id: "admin-guard" }, { $setOnInsert: { revision: 0 } }, { upsert: true });
}
