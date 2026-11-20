# Server implementation milestones

These completed feature groups are retained for the user-owned two-day commit handoff. No commits or pushes are created by the implementation agent. Shared files may require explicit hunk staging in the final guide.

1. Establish TypeScript/Node/Cloudflare tooling — package.json, package-lock.json, tsconfig.json, wrangler.jsonc, ignored environment templates.
2. Define strongly typed API/domain identities and wire serialization — src/types.ts, src/lib/serialize.ts.
3. Configure request-scoped MongoDB clients and required indexes — src/lib/database.ts.
4. Add validation, date normalization, and structured errors — src/lib/validation.ts, src/lib/dates.ts, src/lib/errors.ts.
5. Enforce JWT/JWKS verification and current-role middleware — src/middleware/auth.ts.
6. Build public catalog and owned equipment CRUD/approval — src/routes/equipment.ts.
7. Add profile/admin account management and last-admin protection — src/routes/users.ts.
8. Persist isolated customer favorites — src/routes/favorites.ts.
9. Calculate rental periods and serialize inventory reservations — src/lib/pricing.ts, src/services/inventory.ts.
10. Integrate hosted Checkout, reservation reconciliation, and idempotent fulfillment — src/services/payments.ts.
11. Expose rental dashboards, signed Stripe webhooks, analytics, and authenticated uploads — src/routes/bookings.ts, src/routes/analytics.ts, src/routes/uploads.ts.
12. Automate ended-rental completion and retry-safe customer/owner email notifications — src/services/rentals.ts, src/services/notifications.ts, src/services/scheduled.ts.
13. Connect Worker/local HTTP lifecycle and validate delivery — src/app.ts, src/index.ts, src/node.ts, tests/rentals.test.ts, scripts/integration.ts, README.md, docs/API.md.
