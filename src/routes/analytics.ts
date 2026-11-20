import { Router } from "express";
import type { Db, Filter } from "mongodb";
import type { Booking, Payment } from "../types";
import { verifyToken, verifyOwner, verifyAdmin } from "../middleware/auth";
import { success } from "../lib/errors";

function recentMonths() {
  const date = new Date();
  return Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 11 + index, 1));
    return month.toISOString().slice(0, 7);
  });
}

async function monthlyTotals(db: Db, bookingFilter: Filter<Booking>, paymentFilter: Filter<Payment>) {
  const months = recentMonths();
  const from = new Date(`${months[0]}-01T00:00:00.000Z`);
  const [bookings, payments] = await Promise.all([
    db.collection<Booking>("bookings").aggregate<{ _id: string; bookings: number }>([{ $match: { ...bookingFilter, createdAt: { $gte: from } } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Dhaka" } }, bookings: { $sum: 1 } } }]).toArray(),
    db.collection<Payment>("payments").aggregate<{ _id: string; amountCents: number }>([{ $match: { ...paymentFilter, status: "paid", createdAt: { $gte: from } } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Dhaka" } }, amountCents: { $sum: "$amountCents" } } }]).toArray()
  ]);
  return months.map((month) => ({ month, bookings: bookings.find((row) => row._id === month)?.bookings ?? 0, amountCents: payments.find((row) => row._id === month)?.amountCents ?? 0 }));
}

export function analyticsRoutes() {
  const router = Router();
  router.get("/admin/analytics", verifyToken, verifyAdmin, async (req, res) => {
    const db = req.context.db;
    const [totalUsers, totalEquipment, totalBookings, pendingApprovals, completedRentals, revenue, monthly] = await Promise.all([
      db.collection("users").countDocuments(),
      db.collection("equipment").countDocuments({ deletedAt: { $exists: false } }),
      db.collection("bookings").countDocuments(),
      db.collection("equipment").countDocuments({ status: "pending", deletedAt: { $exists: false } }),
      db.collection("bookings").countDocuments({ status: "completed" }),
      db.collection("payments").aggregate<{ total: number }>([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amountCents" } } }]).toArray(),
      monthlyTotals(db, {}, {})
    ]);
    success(res, { totalUsers, totalEquipment, totalBookings, pendingApprovals, completedRentals, totalRevenueCents: revenue[0]?.total ?? 0, monthlyBookings: monthly.map(({ amountCents, ...row }) => ({ ...row, revenueCents: amountCents })) });
  });
  router.get("/owner/analytics", verifyToken, verifyOwner, async (req, res) => {
    const db = req.context.db;
    const filter = { ownerId: req.user._id };
    const [totalEquipment, totalBookings, completedRentals, earnings, monthly] = await Promise.all([
      db.collection("equipment").countDocuments({ ...filter, deletedAt: { $exists: false } }),
      db.collection("bookings").countDocuments(filter),
      db.collection("bookings").countDocuments({ ...filter, status: "completed" }),
      db.collection("payments").aggregate<{ total: number }>([{ $match: { ...filter, status: "paid" } }, { $group: { _id: null, total: { $sum: "$amountCents" } } }]).toArray(),
      monthlyTotals(db, filter, filter)
    ]);
    success(res, { totalEquipment, totalBookings, completedRentals, totalEarningsCents: earnings[0]?.total ?? 0, monthlyEarnings: monthly.map(({ amountCents, ...row }) => ({ ...row, earningsCents: amountCents })) });
  });
  return router;
}
