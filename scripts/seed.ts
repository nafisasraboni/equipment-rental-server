import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";
import { ensureIndexes } from "../src/lib/database";
import type { Category, Equipment, RentalType, User } from "../src/types";

if (existsSync(".env")) process.loadEnvFile(".env");
const ownerEmail = process.env.SEED_OWNER_EMAIL;
if (!process.env.MONGODB_URI || !ownerEmail) throw new Error("Configure MONGODB_URI and SEED_OWNER_EMAIL before seeding.");

type Listing = Pick<Equipment, "name" | "category" | "rentalType" | "rentalPriceCents" | "quantity" | "brand" | "model"> & { photo: string };
const listing = (name: string, category: Category, rentalType: RentalType, rentalPriceCents: number, quantity: number, brand: string, model: string, photo: string): Listing => ({ name, category, rentalType, rentalPriceCents, quantity, brand, model, photo });
const listings: Listing[] = [
  listing("Sony Alpha A7 III Camera", "photography", "daily", 4500, 4, "Sony", "Alpha A7 III", "photo-1516035069371-29a1b244cc32"),
  listing("Canon EOS Photography Kit", "photography", "weekly", 18000, 2, "Canon", "EOS R6", "photo-1502920917128-1aa500764cbd"),
  listing("Compact Excavator", "construction", "daily", 16000, 2, "CAT", "302 CR", "photo-1504307651254-35680f356dfd"),
  listing("Cordless Power Tool Kit", "construction", "weekly", 8500, 5, "DeWalt", "20V MAX", "photo-1581783898377-1c85bf937427"),
  listing("City Hatchback", "transportation", "daily", 6500, 3, "Toyota", "Corolla", "photo-1492144534655-ae79c964c9d7"),
  listing("Adventure Bicycle", "transportation", "weekly", 3500, 6, "Trek", "Marlin 5", "photo-1485965120184-e220f721d03e"),
  listing("Farm Tractor", "agriculture", "daily", 12000, 2, "John Deere", "5050D", "photo-1530267981375-f0de937f5f13"),
  listing("Garden Cultivator", "agriculture", "weekly", 11000, 3, "Honda", "FG110", "photo-1500382017468-9049fed747ef"),
  listing("MacBook Pro Workstation", "electronics", "monthly", 24000, 5, "Apple", "MacBook Pro 14", "photo-1517336714731-489689fd1ca8"),
  listing("Portable Projector", "electronics", "daily", 3500, 4, "Epson", "EF-12", "photo-1593359677879-a4bb92f829d1"),
  listing("Event Sound System", "events", "daily", 9000, 4, "JBL", "EON 715", "photo-1493225457124-a3eb161ffa5f"),
  listing("Outdoor Event Setup", "events", "weekly", 28000, 2, "GearNest", "Garden Collection", "photo-1511795409834-ef04bbd61622"),
];

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2 });
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "gearnest");
  await ensureIndexes(db);
  const owner = await db.collection<User>("users").findOne({ email: ownerEmail, role: "owner", status: "active" });
  if (!owner) throw new Error("Seed owner must already have an active Owner account.");
  const now = new Date();
  const examples = [
    ...listings.map((item) => ({ item, status: "approved" as const })),
    { item: { ...listings[0], name: "Studio Camera Awaiting Review" }, status: "pending" as const },
    { item: { ...listings[1], name: "Incomplete Photography Listing" }, status: "rejected" as const },
  ];
  let inserted = 0;
  for (const [index, { item, status }] of examples.entries()) {
    const { photo, ...fields } = item;
    const equipment: Equipment = {
      ...fields, _id: crypto.randomUUID(), ownerId: owner._id, status,
      description: `${item.name} for projects, events, and short-term use. This demonstration listing illustrates the GearNest rental workflow. Contact the owner to confirm pickup and equipment specifications.`,
      location: index % 2 === 0 ? "Dhaka, Bangladesh" : "Chattogram, Bangladesh",
      image: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1000&q=85`,
      condition: "Excellent", terms: "Bring a valid identification document at pickup. Use the equipment responsibly and return it clean, complete, and on time. Agree on delivery with the owner before the rental begins.",
      inventoryRevision: 0, createdAt: new Date(now.getTime() - index * 60_000), updatedAt: now,
      ...(status === "rejected" ? { rejectionReason: "Please provide complete equipment specifications and an updated photo." } : {}),
    };
    const result = await db.collection<Equipment>("equipment").updateOne({ ownerId: owner._id, name: item.name }, { $setOnInsert: equipment }, { upsert: true });
    inserted += result.upsertedCount;
  }
  console.log(`Prepared 14 demonstration listings across six categories; ${inserted} inserted. Existing listings were preserved.`);
} finally { await client.close(); }
