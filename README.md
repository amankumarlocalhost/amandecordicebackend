# Crockery Commerce Backend

Backend for an Indian e-commerce store selling **crockery, glassware, kitchenware, tableware and home decor**. It is built for fragile, set-based and bundled products. It covers:

- Catalog, inventory, cart, checkout and a pricing engine
- **UPI (Razorpay) and Cash on Delivery only**
- Coupons and festival campaigns
- Shipping with fragile-handling rules
- Orders, returns, replacements and refunds
- Socket.IO chat and notifications
- **Google Gemini** assistants for customers and admins
- Analytics

Stack: Node.js 24, Express 5, MongoDB/Mongoose 8 (replica set), Redis, BullMQ, Socket.IO 4, Zod 4, Pino, Argon2id, Razorpay SDK, `@google/genai`, Sharp, S3-compatible storage, Jest + Supertest.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data model, state machines, business rules, metric definitions |
| [docs/API.md](docs/API.md) | API conventions and route map (full spec: `/api/docs`, `docs/openapi.json`) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production setup, scaling, backups, monitoring, rollback, secret rotation |
| [docs/SECURITY.md](docs/SECURITY.md) | Security & production-readiness checklist |
| [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md) | Measured performance and what it does and doesn't prove |
| [docs/STATUS.md](docs/STATUS.md) | What's done, known limitations, integrations needing credentials |

## Quick start

### Option A: nothing installed except Node (in-memory MongoDB)

```bash
cd backend
npm install
npm run dev:memory
```

This starts an in-memory MongoDB replica set, seeds about 54 categories and 13 products with stock, creates the admin `admin@crockery.local` / `ChangeMe-Admin-123`, and serves the API on `:4000`. Swagger UI is at http://localhost:4000/api/docs. All data is lost when the process stops.

### Option B: Docker Compose (MongoDB replica set + Redis + API + worker)

```bash
cp .env.example .env            # fill the three secrets: openssl rand -base64 48
docker compose up --build
docker compose exec api npm run seed -- --with-stock
docker compose exec api npm run create-admin -- --email you@store.in --password 'A-Long-Admin-Pass-1'
```

### Option C: your own MongoDB/Redis

```bash
cp .env.example .env            # set MONGODB_URI (replica set!), REDIS_URL and the secrets
npm run sync-indexes
npm run seed -- --with-stock    # optional demo catalog
npm run create-admin -- --email you@store.in --password 'A-Long-Admin-Pass-1'
npm run dev                     # API with in-process workers
```

## Scripts

| Script | Purpose |
|---|---|
| `npm start` / `npm run dev` | API (+ Socket.IO); `dev` restarts on change |
| `npm run worker` | Standalone BullMQ worker and schedulers (needs Redis) |
| `npm run dev:memory` | Zero-install dev server (in-memory MongoDB, seeded) |
| `npm test` | 95 Jest/Supertest tests against an in-memory MongoDB **replica set** (real transactions) |
| `npm run seed [-- --with-stock]` | Additive, idempotent demo catalog; refuses production without `--allow-production` |
| `npm run create-admin -- --email … --password …` | First Super Admin (staff can never self-register) |
| `npm run sync-indexes [-- --drop-extra]` | Build indexes (run on every deploy) |
| `npm run docs:export` | Write `docs/openapi.json` |
| `npm run loadtest:http` / `loadtest:sockets` | Load tests (see docs/LOAD_TEST_RESULTS.md) |
| `npm run audit:deps` | `npm audit` of production dependencies |

## Environment variables

Every variable is validated with Zod at startup. In production the app **refuses to start** if any of these is true:

- Default or duplicate secrets are in use
- `REDIS_URL` is missing
- `COOKIE_SECURE` is false
- `DEV_EXPOSE_OTP` is on

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | | `development` \| `test` \| `production` |
| `PORT`, `APP_URL` | | Listen port; public base URL (used for local upload URLs and OpenAPI) |
| `FRONTEND_URL` | ✔ | Comma-separated allowed browser origins (CORS and the Socket.IO origin check) |
| `TRUST_PROXY` | prod | Reverse-proxy hop count, so rate limits see real client IPs |
| `MONGODB_URI` | ✔ | **Replica set or Atlas**: transactions guard stock, coupons, payments and refunds |
| `MONGODB_MAX_POOL_SIZE` | | Connections per process (default 50) |
| `MONGODB_AUTO_INDEX` | | `false` in production (use `sync-indexes`) |
| `REDIS_URL` | prod | Distributed rate limits, caches, BullMQ, Socket.IO adapter, presence |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET` | ✔ | ≥ 32 characters each and all different. These sign access tokens, pepper refresh-token/OTP hashes, and sign CSRF and guest-cart cookies |
| `ACCESS_TOKEN_TTL_MIN`, `REFRESH_TOKEN_TTL_DAYS` | | 15 min / 30 days. Staff refresh sessions last 1 day |
| `COOKIE_DOMAIN`, `COOKIE_SAMESITE`, `COOKIE_SECURE` | | Cookie scope. `none` requires `secure` |
| `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST` | | Argon2id cost (OWASP baseline 19456 KiB, t=2) |
| `GEMINI_API_KEY` | AI | Server-side only. Without it, the AI features fall back to search/FAQ answers |
| `GEMINI_MODEL`, `GEMINI_ADMIN_MODEL` | | Configurable model ids (default `gemini-2.5-flash`) |
| `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_CONCURRENCY`, `GEMINI_MAX_RETRIES` | | Reliability limits |
| `AI_DAILY_CUSTOMER_REQUESTS`, `AI_DAILY_ADMIN_REQUESTS` | | Hard per-user daily caps. The admin AI settings can only lower them |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | UPI | Without them, UPI is disabled at checkout and COD keeps working |
| `RAZORPAY_WEBHOOK_SECRET` | UPI | Verifies webhooks (HMAC over the raw body) |
| `STORAGE_DRIVER` + `OBJECT_STORAGE_*` | prod | `s3` for AWS S3/R2/MinIO/Spaces. `local` is for development |
| `SMTP_*`, `EMAIL_FROM` | email | Without SMTP, emails are logged in development and skipped in production |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER` | | `console` (development logging only) or `none`. A real provider adapter must be added |
| `LOG_LEVEL` | | Pino level. Secrets, cookies, OTPs and signatures are redacted |
| `RATE_LIMIT_*`, `AUTH_/OTP_/CHECKOUT_RATE_LIMIT_MAX` | | Per-IP and per-user limits |
| `RUN_WORKERS`, `RUN_SCHEDULERS` | | Set `false` on API pods when running `src/worker.js` separately |
| `DEV_EXPOSE_OTP` | | Development only. Returns OTPs and email tokens in responses |

## What the client must do

- Fetch `GET /api/v1/auth/csrf` once. Then send `X-CSRF-Token` on every POST/PUT/PATCH/DELETE (cookie auth).
- Send an `Idempotency-Key` (UUID) with `POST /checkout/place-order`. Optionally send `expectedTotal` to detect stale prices.
- For UPI, open Razorpay Checkout with the returned `checkoutOptions` (already UPI-only). Then POST the callback to `/payments/razorpay/verify`. The order is confirmed only by the server.
- All money values are **integer paise**.
- Socket.IO connects with the same auth cookie (or `auth: { token }`). Events are listed in docs/API.md.
