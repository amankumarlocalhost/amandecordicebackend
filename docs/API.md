# API conventions

The full, generated specification has 225 operations. It is served at `/api/docs` (Swagger UI) and `/api/docs.json`, and exported to `docs/openapi.json` with `npm run docs:export`.

## Envelope

```json
{ "success": true,  "message": "OK", "data": {}, "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }
{ "success": false, "message": "Only 2 unit(s) of DS-IVORY-24 available", "error": { "code": "OUT_OF_STOCK", "details": { "sku": "DS-IVORY-24", "available": 2 } }, "requestId": "…" }
```

- Errors carry a stable `code` (`VALIDATION_ERROR`, `CSRF_INVALID`, `INVALID_TRANSITION`, `PRICE_CHANGED`, `CHECKOUT_BLOCKED`, `REFUND_EXCEEDS_PAID`, …).
- Production responses never include stack traces.
- Every response has an `X-Request-Id` header.

## Conventions

- **Money** is integer paise.
- **Dates** are ISO 8601 UTC. Campaign inputs may be local times plus a `timezone` (default `Asia/Kolkata`).
- **Pagination**: `page` (≥ 1) and `limit` (1–100).
- **Auth**: `access_token` (15 min) and `refresh_token` (rotating, path `/api/v1/auth`) are HttpOnly cookies. Non-browser clients send `X-Client-Type: mobile` to receive tokens in the body and then use `Authorization: Bearer`.
- **CSRF**: cookie-authenticated unsafe requests need the `X-CSRF-Token` header, set to the value of the `csrf_token` cookie (`GET /api/v1/auth/csrf`).
- **Idempotency**: `Idempotency-Key` is **required** on `POST /checkout/place-order`, and optional on `POST /returns` and `POST /admin/refunds`.
- **PATCH** updates only the fields you send.

## Route map

| Area | Routes |
|---|---|
| Auth | `/auth/csrf, register, login, admin/login, otp/send, otp/verify-phone, otp/login, email/verify, email/resend-verification, refresh, logout, logout-all, sessions, password/forgot, password/reset, password/change` |
| Account | `/users/me`, `/users/me/notification-preferences`, `/users/me/deactivate`, `/users/me/delete-request`, `/addresses` |
| Catalog | `/categories`, `/collections`, `/products` (filters: `q, category, collection, brand, material, color, pattern, minPrice, maxPrice, min/maxCapacityMl, setSize, minPieces, serves, inStock, featured, bestseller, newArrival, discounted, microwaveSafe, dishwasherSafe, giftWrap, type, sort`), `/products/facets`, `/products/:slug`, `/products/:slug/related`, `/products/:id/back-in-stock`, `/search`, `/search/suggest` |
| Engagement | `/products/:id/reviews`, `/reviews/:id` (+ `/helpful`, `/report`), `/products/:id/questions`, `/wishlist` |
| Cart & checkout | `/cart` (+ `/items`, `/coupon`, `/options`), `/checkout/quote`, `/checkout/place-order`, `/shipping/serviceability/:pincode`, `/settings/public`, `/promotions/active`, `/coupons/available` |
| Orders & payments | `/orders`, `/orders/:id` (+ `/tracking`, `/cancel`, `/invoice`), `/payments/razorpay/verify`, `/payments/orders/:id/retry`, `/webhooks/razorpay`, `/refunds`, `/refunds/:id/destination` |
| Returns | `/returns/eligibility/:orderId`, `/returns`, `/returns/:id` (+ `/cancel`), `/replacements`, `/uploads?purpose=return\|chat\|review` |
| Support & AI | `/chat/conversations` (+ `/messages`, `/read`, `/handoff`, `/close`), `/support/tickets`, `/notifications`, `/ai/customer/status`, `/ai/customer/proposals/:id` (+ `/confirm`, `/decline`) |
| Admin | `/admin/products, categories, collections, media, inventory, suppliers, purchases, orders, shipments, pincodes, couriers, payments, refunds, returns, replacements, campaigns, promotions, coupons, customers, staff, reviews, questions, support/*, notification-templates, settings/:section, analytics/*, audit-logs, system/*`, `/ai/admin/chat, sessions, proposals` |

All routes are prefixed with `/api/v1`. Health checks: `/health/live`, `/health/ready`, `/health/metrics`.

## Socket.IO

Connect with the auth cookie or `io(url, { auth: { token } })`. The origin must be in `FRONTEND_URL`. Every event takes an ack callback that receives `{ ok, data | error }`.

| Client → server | Payload |
|---|---|
| `chat:start` | `{ channel: 'ai'\|'human', orderId? }` → conversation + history |
| `chat:join` / `chat:leave` | `{ conversationId }` |
| `chat:message` | `{ conversationId, clientMessageId, body, attachmentIds? }`. Re-sending the same `clientMessageId` after a reconnect returns `duplicate: true` and triggers nothing |
| `chat:typing` | `{ conversationId, typing }` |
| `chat:read`, `chat:handoff`, `chat:close` | `{ conversationId }` |
| `ai:confirm` / `ai:decline` | `{ proposalId }` |

| Server → client | Meaning |
|---|---|
| `chat:message`, `chat:typing`, `chat:read`, `chat:unread` | Conversation updates. AI messages have `kind`: `text`, `products` (`payload.products`), `action_proposal` (`payload.proposalId`, `preview`, `actions`), `action_result` |
| `notification:new` | Durable in-app notification |
| `support:conversation`, `support:message`, `support:ticket`, `staff:alert`, `presence` | Staff rooms only |
| `auth:expired` | Access token expired. Refresh and reconnect |

Limits: 64 KB per frame, 20 events per burst with a refill of 2/s, and 2,000 characters per message.
