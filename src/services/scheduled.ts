import type { Db, MongoClient } from "mongodb";
import type { Env } from "../types";
import { deliverPendingNotifications, queueExistingBookingNotifications } from "./notifications";
import { reconcileIntents } from "./payments";
import { completeEndedRentals, queueExistingCompletionNotifications } from "./rentals";

export async function runScheduledJobs(env: Env, db: Db, client: MongoClient) {
  await reconcileIntents(env, db, client);
  const bookingEmailsQueued = await queueExistingBookingNotifications(env, db);
  const completed = await completeEndedRentals(env, db, client);
  const queued = await queueExistingCompletionNotifications(env, db, client);
  const email = await deliverPendingNotifications(env, db);
  console.info("Scheduled GearNest jobs finished", { bookingEmailsQueued, completed, completionEmailsQueued: queued, emailSent: email.sent, emailFailed: email.failed, emailConfigured: email.configured });
  return { bookingEmailsQueued, completed, queued, email };
}
