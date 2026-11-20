# API contract

All endpoints use `{ success: true, data, message? }` or `{ success: false, error: { code, message, details? } }`. Paginated data is `{ items, page, limit, total, totalPages }`. IDs are UUID strings. Dates are ISO timestamps except rental start/end dates, which use `YYYY-MM-DD` in the Asia/Dhaka business calendar. Currency is USD; monetary fields are integer cents.

Protected endpoints require `Authorization: Bearer <JWT>` issued by the client's Better Auth JWT plugin. A Better Auth session token is not an API JWT.

| Endpoint | Access | Behavior |
|---|---|---|
| GET `/api/health` | Public | Database connectivity |
| GET `/api/equipment` | Public | Search/filter/sort/paginate approved equipment |
| GET `/api/equipment/featured` | Public | Up to 6 approved items |
| GET `/api/equipment/home` | Public | Featured and recent homepage equipment in one response |
| GET `/api/equipment/:id` | Authenticated | Customers view approved items; managers may view their pending items |
| POST `/api/equipment` | Owner | Create pending equipment |
| PATCH `/api/equipment/:id` | Owner/Admin | Partial equipment update; ownership enforced |
| DELETE `/api/equipment/:id` | Owner/Admin | Soft-delete listing |
| GET `/api/owner/equipment` | Owner | Own paginated equipment |
| GET/PATCH `/api/me` | Authenticated | Current profile; update name/image/phone/address |
| GET `/api/favorites` | Customer | Own paginated favorites |
| PUT/DELETE `/api/favorites/:equipmentId` | Customer | Idempotent add/remove |
| POST `/api/bookings/quote` | Customer | Server price and interval availability |
| POST `/api/bookings/checkout` | Customer | Reserve stock and open Stripe Checkout |
| GET `/api/bookings/verify?sessionId=…` | Customer | Verify owned Stripe session, finalize paid rental |
| POST `/api/webhooks/stripe` | Stripe signature | Raw-body signed fulfillment/expiry events |
| GET `/api/customer/bookings` | Customer | Own paid bookings |
| GET `/api/owner/bookings` | Owner | Bookings for own equipment |
| GET `/api/admin/bookings` | Admin | All bookings |
| PATCH `/api/admin/bookings/:id` | Admin | Complete an ended booking and queue customer/owner emails |
| GET `/api/admin/users` | Admin | Paginated users |
| PATCH `/api/admin/users/:id` | Admin | Change role/status; last-admin protection |
| GET `/api/admin/equipment` | Admin | All active listings, optional status filter |
| PATCH `/api/admin/equipment/:id/status` | Admin | Pending/approved/rejected, optional rejection reason |
| GET `/api/admin/analytics` | Admin | Platform counts, revenue,12-month booking chart |
| GET `/api/owner/analytics` | Owner | Own counts, earnings,12-month chart |
| POST `/api/uploads` | Authenticated | Multipart field `image`, maximum8MiB JPEG/PNG/WebP/GIF |

Catalog query fields: `search`, `category`, `rentalType`, `minPrice`, `maxPrice`, `availability`, `sort`, `page`, `limit`. Price bounds use USD decimal amounts. Categories: construction, photography, transportation, agriculture, electronics, events. Rental types: daily, weekly, monthly. Sort: price_asc, price_desc, recent. Availability refers to today's stock; booking quotes verify selected dates.

Quote request: `{ equipmentId, startDate, endDate, quantity }`. Quote response: `{ totalAmountCents, days, periods, quantity, currency, availableQuantity }`.

Checkout adds `{ contactNumber, deliveryAddress, notes, requestId }`; `requestId` is a fresh UUID per distinct attempt and stays unchanged for a retry. Response: `{ url, intentId, sessionId }`. Verify returns `{ booking, paymentStatus, status }`; only provider-confirmed paid sessions generate bookings.

Equipment price/stock fields: `rentalPriceCents`, `rentalType`, `quantity` (total inventory), `availableQuantity` (computed current availability). Other fields match `src/types.ts`; wire objects replace `_id` with `id`. Owner and booking person snapshots contain id/name/email/image. Favorite equipment can be null when its listing is unpublished or removed.

Paid bookings immediately queue customer and owner confirmation emails. Bookings are completed automatically by the scheduled job after the inclusive end date has passed, which queues a second completion notification for both parties. Emails are persisted in `emailNotifications` before delivery, retried with leases/backoff, and sent with deterministic provider idempotency keys.
