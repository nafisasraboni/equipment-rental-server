import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import { createApp } from "../src/app";
import { ensureIndexes } from "../src/lib/database";
import { today } from "../src/lib/dates";
import { reserveRental, finalizeCheckout, type PaymentCheckout } from "../src/services/payments";
import { completeBooking } from "../src/services/rentals";
import type { Env, Equipment, RentalIntent, User } from "../src/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.MONGODB_URI) throw new Error("Set MONGODB_URI in the ignored server/.env before running integration checks.");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local integration listener failed.");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function offsetDate(days: number) { return new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 4, serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB ?? "gearnest");
await ensureIndexes(db);
const userIds = Array.from({ length: 5 }, () => crypto.randomUUID());
const roles = ["customer", "customer", "owner", "owner", "admin"] as const;
const users: User[] = roles.map((role, index) => ({ _id: userIds[index], name: `Integration ${role} ${index}`, email: `integration-${userIds[index]}@example.com`, role, status: "active", image: null, createdAt: new Date() }));
await db.collection<User>("users").insertMany(users);
const equipmentIds: string[] = [];
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "gearnest-integration", alg: "RS256", use: "sig" };
const jwks = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
const issuer = await listen(jwks);
const env: Env = { MONGODB_URI: process.env.MONGODB_URI, MONGODB_DB: process.env.MONGODB_DB ?? "gearnest", CLIENT_ORIGIN: "http://localhost:3000", AUTH_ISSUER: issuer, JWT_AUDIENCE: "gearnest-integration", STRIPE_SECRET_KEY: "sk_test_gearnest_integration_fixture", STRIPE_WEBHOOK_SECRET: "whsec_gearnest_integration_fixture", IMGBB_API_KEY: process.env.IMGBB_API_KEY ?? "" };
const api = createServer(createApp(() => ({ env, db, client })));
const origin = await listen(api);
const tokens = await Promise.all(users.map((user) => new SignJWT({ role: user.role }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(user._id).setIssuer(issuer).setAudience(env.JWT_AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(privateKey)));
let assertions = 0;
const responseDataSchema = z.object({ id: z.string().optional(), status: z.string().optional(), items: z.array(z.object({ id: z.string().optional() }).passthrough()).optional(), totalAmountCents: z.number().optional(), totalEarningsCents: z.number().optional(), completedRentals: z.number().optional(), monthlyEarnings: z.array(z.unknown()).optional() }).passthrough();
const responseSchema = z.object({ success: z.boolean(), data: z.union([responseDataSchema, z.array(responseDataSchema)]).optional(), error: z.unknown().optional() }).passthrough();
async function request(path: string, options: { method?: string; body?: unknown; token?: number; origin?: string } = {}) {
  const response = await fetch(`${origin}/api${path}`, { method: options.method ?? "GET", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.token !== undefined ? { Authorization: `Bearer ${tokens[options.token]}` } : {}), ...(options.origin ? { Origin: options.origin } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = responseSchema.parse(await response.json());
  const data: z.infer<typeof responseDataSchema> = Array.isArray(body.data) ? { items: body.data } : body.data ?? {};
  return { status: response.status, body: { ...body, data } };
}
function check(condition: unknown, message: string): asserts condition { assert.ok(condition, message); assertions++; }

try {
  check((await request("/health")).status === 200, "Real database health should succeed");
  check((await request("/missing-route")).status === 404, "Unknown routes should return structured404");
  check((await request("/me")).status === 401, "Private routes require a JWT");
  check((await request("/health", { origin: "https://untrusted.example" })).status === 403, "Untrusted CORS origins are rejected");
  check((await request("/admin/users", { token: 0 })).status === 403, "Customers cannot list admin users");
  check((await request("/owner/equipment", { token: 0 })).status === 403, "Customers cannot list owner equipment");
  check((await request("/me", { token: 0, method: "PATCH", body: { name: "Attempted admin", role: "admin" } })).status === 400, "Profile cannot escalate roles");

  const name = `Integration camera ${crypto.randomUUID().slice(0, 8)}`;
  const created = await request("/equipment", { token: 2, method: "POST", body: { name, description: "A temporary integration fixture for rental inventory verification.", category: "photography", location: "Dhaka", rentalPriceCents: 3000, rentalType: "daily", quantity: 1, condition: "excellent", image: "https://i.ibb.co/example/integration.png", terms: "Temporary test fixture. Return equipment safely." } });
  check(created.status === 201 && created.body.data.status === "pending", "Owner equipment starts pending");
  const equipmentId = z.string().uuid().parse(created.body.data.id);
  equipmentIds.push(equipmentId);
  check((await request(`/equipment/${equipmentId}`, { token: 0 })).status === 403, "Customers cannot inspect pending equipment");
  check((await request(`/equipment/${equipmentId}`, { token: 3, method: "PATCH", body: { name: "Another owner edit" } })).status === 403, "Ownership protects equipment updates");
  check((await request(`/admin/equipment/${equipmentId}/status`, { token: 4, method: "PATCH", body: { status: "approved" } })).status === 200, "Admins can approve equipment");
  const catalog = await request(`/equipment?search=${encodeURIComponent(name)}&category=photography&minPrice=29&maxPrice=31&availability=available&sort=price_asc`);
  check(catalog.status === 200 && catalog.body.data.items?.some((item) => item.id === equipmentId), "Backend search/filter/sort returns approved equipment");
  check(((await request("/equipment/featured")).body.data.items?.length ?? 7) <= 6, "Featured equipment is limited to6");
  await request(`/favorites/${equipmentId}`, { token: 0, method: "PUT" });
  await request(`/favorites/${equipmentId}`, { token: 0, method: "PUT" });
  const favorites = await request("/favorites", { token: 0 });
  check(favorites.body.data.items?.length === 1, "Duplicate favorites are idempotent");
  check((await request("/favorites", { token: 1 })).body.data.items?.length === 0, "Customer favorites are isolated");

  const input = { equipmentId, startDate: offsetDate(2), endDate: offsetDate(4), quantity: 1, contactNumber: "+8801700000000", deliveryAddress: "Temporary integration test address", notes: "" };
  const quote = await request("/bookings/quote", { token: 0, method: "POST", body: { equipmentId, startDate: input.startDate, endDate: input.endDate, quantity: 1 } });
  check(quote.status === 200 && quote.body.data.totalAmountCents === 9000, "Server quote derives inclusive dates and database price");
  check((await request("/bookings/checkout", { token: 0, method: "POST", body: { ...input, requestId: crypto.randomUUID(), amountCents: 1 } })).status === 400, "Clients cannot submit an alternate payment amount");
  const reservations = await Promise.allSettled([reserveRental(env, db, client, users[0], input, crypto.randomUUID()), reserveRental(env, db, client, users[1], input, crypto.randomUUID())]);
  const accepted = reservations.filter((result): result is PromiseFulfilledResult<RentalIntent> => result.status === "fulfilled");
  check(accepted.length === 1, "Concurrent requests for the last unit yield one reservation");
  const intent = accepted[0].value;
  check((await request(`/equipment/${equipmentId}`, { token: 2, method: "PATCH", body: { quantity: 1 } })).status === 200, "Existing reserved stock can remain unchanged");
  const heldEquipment = await db.collection<Equipment>("equipment").findOne({ _id: equipmentId });
  check(heldEquipment?.status === "pending", "Owner edits return equipment to review");
  await request(`/admin/equipment/${equipmentId}/status`, { token: 4, method: "PATCH", body: { status: "approved" } });
  const checkout: PaymentCheckout = { id: `cs_test_${crypto.randomUUID().replace(/-/g, "")}`, metadata: { intentId: intent._id }, payment_status: "paid", amount_total: intent.amountCents, currency: "usd", client_reference_id: intent.customerId, payment_intent: `pi_test_${crypto.randomUUID().replace(/-/g, "")}` };
  const paid = await Promise.all([finalizeCheckout(db, client, checkout), finalizeCheckout(db, client, checkout)]);
  check(paid[0]._id === paid[1]._id, "Concurrent fulfillment returns one booking");
  check(await db.collection("bookings").countDocuments({ intentId: intent._id }) === 1, "One booking is saved for repeated payment completion");
  check(await db.collection("payments").countDocuments({ checkoutSessionId: checkout.id }) === 1, "One transaction is saved for repeated payment completion");

  const payload = JSON.stringify({ id: `evt_test_${crypto.randomUUID()}`, object: "event", type: "checkout.session.completed", data: { object: checkout } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  const webhook = await fetch(`${origin}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${signature}` }, body: payload });
  check(webhook.status === 200, "A correctly signed raw webhook can fulfill idempotently");
  const invalidWebhook = await fetch(`${origin}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=invalid` }, body: payload });
  check(invalidWebhook.status === 400, "Invalid webhook signatures are rejected");
  check((await request(`/admin/bookings/${paid[0]._id}`, { token: 4, method: "PATCH", body: { status: "completed" } })).status === 409, "A rental cannot complete before its inclusive end date");
  const completed = await completeBooking(env, db, client, paid[0]._id, offsetDate(5));
  check(completed.status === "completed", "An ended rental is completed by the shared scheduled service");
  check(await db.collection("emailNotifications").countDocuments({ bookingId: completed._id }) === 2, "Completion queues one idempotent email for customer and owner");
  const winningUser = users.findIndex((user) => user._id === intent.customerId);
  const losingUser = winningUser === 0 ? 1 : 0;
  check((await request("/customer/bookings", { token: winningUser })).body.data.items?.length === 1, "Customer sees only their paid rental");
  check((await request("/customer/bookings", { token: losingUser })).body.data.items?.length === 0, "Other customers cannot see paid rental records");
  check((await request("/owner/bookings", { token: 2 })).body.data.items?.length === 1, "Owner sees rentals for own equipment");
  check((await request("/owner/bookings", { token: 3 })).body.data.items?.length === 0, "Other owners cannot see equipment rentals");
  const ownerAnalytics = await request("/owner/analytics", { token: 2 });
  check(ownerAnalytics.body.data.totalEarningsCents === 9000, "Owner earnings derive from paid transaction records");
  check(ownerAnalytics.body.data.completedRentals === 1, "Completed rentals update owner analytics");
  check(ownerAnalytics.body.data.monthlyEarnings?.length === 12, "Owner charts include all12 months");
  check((await request(`/admin/users/${users[losingUser]._id}`, { token: 4, method: "PATCH", body: { status: "suspended" } })).status === 200, "Admin can suspend another account");
  check((await request("/me", { token: losingUser })).status === 403, "Previously issued JWT cannot bypass current suspension");
  check((await request(`/equipment/${equipmentId}`, { token: 3, method: "DELETE" })).status === 404, "Another owner cannot delete equipment");
  check((await request(`/equipment/${equipmentId}`, { token: 2, method: "DELETE" })).status === 200, "Owner can soft-delete equipment");
  check(await db.collection("bookings").countDocuments({ intentId: intent._id }) === 1, "Deletion preserves paid rental history");
  console.log(`PASS: ${assertions} HTTP/database integration assertions, including concurrent reservation and signed webhook verification.`);
} finally {
  await close(api);
  await close(jwks);
  await db.collection("payments").deleteMany({ customerId: { $in: userIds } });
  await db.collection("emailNotifications").deleteMany({ bookingId: { $in: await db.collection("bookings").distinct("_id", { customerId: { $in: userIds } }) } });
  await db.collection("bookings").deleteMany({ customerId: { $in: userIds } });
  await db.collection("rentalIntents").deleteMany({ customerId: { $in: userIds } });
  await db.collection("favorites").deleteMany({ customerId: { $in: userIds } });
  await db.collection<Equipment>("equipment").deleteMany({ _id: { $in: equipmentIds } });
  await db.collection<User>("users").deleteMany({ _id: { $in: userIds } });
  await client.close();
}
