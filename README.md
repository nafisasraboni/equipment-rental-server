# GearNest — Equipment Rental Platform API

GearNest connects customers with equipment owners through approved listings, dated rental reservations, and secure Stripe sandbox payments. This is the separate Express backend for the Next.js App Router client.

## Features

- JWT/JWKS authentication backed by Better Auth's shared MongoDB users, with current role and suspension checks.
- Customer/Owner/Admin permissions and record ownership enforcement.
- Server-side catalog search, category/rental type/price/availability filtering, sorting, and pagination.
- Owner equipment CRUD, admin approvals, profile updates, and customer favorites.
- Inclusive-date pricing, transaction-protected stock reservations, Stripe hosted Checkout, signed webhooks, and idempotent payment fulfillment.
- Customer/owner/admin rental records and MongoDB-based revenue, booking, and owner earnings analytics.
- Automatic post-rental completion through Node Cron locally and Cloudflare Cron Triggers in production.
- Durable, idempotent completion-email delivery to customers and owners through Resend.
- Authenticated ImgBB uploads through a server-only API key.
- Cloudflare Worker deployment with native Express and request-scoped MongoDB connections.

## Development

Use Node.js 24 or newer. Install dependencies with `npm install`, copy `.env.example` to the ignored `.env`, and configure credentials locally. The client and Better Auth endpoints run on their configured origin; the API verifies JWTs against `${AUTH_ISSUER}/api/auth/jwks`.

```bash
npm run dev
npm run typecheck
npm test
npm run test:integration
npm run build
```

The integration command requires a reachable MongoDB database. It creates uniquely identified temporary fixtures and removes only those fixtures afterward. It checks HTTP RBAC/ownership, actual MongoDB transactions, duplicate fulfillment, signed webhook handling, and analytics. Its synthetic webhook fixture does not prove a real Stripe Checkout charge; hosted Checkout is verified separately against the configured sandbox.

## Environment and deployment

Use `.dev.vars` for Wrangler development and Worker secrets for production. Keep `MONGODB_URI`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `IMGBB_API_KEY`, and `RESEND_API_KEY` server-only. Configure `CLIENT_ORIGIN`, `AUTH_ISSUER`, `JWT_AUDIENCE`, and a verified `EMAIL_FROM` sender for the deployed client/API URLs. `MONGODB_DB` defaults to `gearnest`.

Deploy with `npm run deploy` after secrets and MongoDB network access are configured. Run the exported `ensureIndexes(db)` once during bootstrap. Every five minutes, Node Cron in local Express or Cloudflare's production Cron Trigger reconciles Checkout reservations, completes rentals whose inclusive end date has passed, and delivers queued completion emails with retry-safe provider idempotency.

Live API: https://api.gearnest.sraboni.dev

Live client: https://gearnest.sraboni.dev

Server repository: https://github.com/nafisasraboni/equipment-rental-server

Client repository: https://github.com/nafisasraboni/equipment-rental-client

For a fresh database, bootstrap an active Owner account through the client, set `SEED_OWNER_EMAIL`, and run `npm run seed`. The seed adds 12 approved demonstrations and two review examples without replacing existing listings.

## Rental and management policies

- Start/end dates are inclusive; same-day rental is one day. Weekly and monthly rates bill started 7-day and 30-day periods.
- Money is stored in integer USD cents. The server reads pricing from MongoDB and applies quantity once.
- Pending Checkout holds and paid bookings reserve peak simultaneous stock. Overlapping independent rentals are not incorrectly summed across the entire requested range.
- Paid bookings are created only after payment verification, with separate transaction records and snapshots preserving rental history.
- Owner edits return equipment to pending. Delete actions soft-delete listings; existing bookings remain available.
- All new accounts default to customer. Admins assign elevated roles. The last active admin cannot be demoted or suspended.
- Rentals complete automatically after their inclusive end date passes; admins can also trigger the same idempotent completion flow. Refund/cancellation policy, email verification, and forgotten-password flows remain deferred.

## Packages

Runtime: Express, MongoDB native driver, jose, Stripe, Zod, cors, and Node Cron. Completion emails use the Resend HTTPS API with a database-backed retry outbox. Development: TypeScript, tsx, Wrangler, Cloudflare Worker types, and Node/Express/cors type declarations. Tests use Node's built-in test runner.

See [API contract](docs/API.md) and [implementation milestones](docs/IMPLEMENTATION-MILESTONES.md). Credentials and examiner passwords are supplied privately in the delivery information.
