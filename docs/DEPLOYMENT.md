# Deployment & operations

> The Dockerfile and docker-compose.yml are provided but were **not built in the development environment** (Docker was not available there). Build and smoke-test them in CI before the first release.

## Reference topology (≈ 1,000 concurrent shoppers)

```
            Cloudflare / CDN (static assets, product images, TLS)
                              │
                 Load balancer / Nginx (TLS, HTTP→HTTPS, WebSocket upgrade)
                 ├── api-1  node src/server.js   RUN_WORKERS=false RUN_SCHEDULERS=false
                 ├── api-2  …                    (2 vCPU / 2 GB each; add instances to scale)
                 └── worker node src/worker.js   (1 instance; 2 for HA — BullMQ is safe to run concurrently)
                              │
        MongoDB Atlas M30+ (replica set, private endpoint)    Redis 7 (managed, private, AOF on, noeviction)
        S3 / R2 bucket (+ CDN) for images                     SMTP / SMS provider
```

- **MongoDB must be a replica set.** Checkout, payments, refunds and returns use multi-document transactions.
- **Never expose MongoDB or Redis publicly.** Use VPC peering or private endpoints, IP allow-lists, TLS and auth.
- Use a least-privilege database user: `readWrite` on the application database only. Run `sync-indexes` with a separate user that has `createIndex`.
- Redis needs `maxmemory-policy noeviction`, because BullMQ requires it.
- `TRUST_PROXY=1` (or your hop count). This lets rate limits and audit logs see real client IPs.
- Socket.IO sticky sessions are **not** required, because clients use the WebSocket transport. If you allow HTTP long-polling, enable sticky sessions on the load balancer. The Redis adapter fans events out across instances, and the worker emits through `@socket.io/redis-emitter`.
- Set `UV_THREADPOOL_SIZE=8` (it is set in the Dockerfile). Argon2 hashing and Sharp image processing run on the libuv thread pool.

## Nginx sketch

```nginx
server {
  listen 443 ssl http2;
  server_name api.yourstore.in;
  client_max_body_size 20m;                 # image uploads; JSON bodies are capped at 200 kB by the app
  location / {
    proxy_pass http://api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;  # Socket.IO
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 75s;
  }
  location /health/metrics { allow 10.0.0.0/8; deny all; proxy_pass http://api_upstream; }
}
```

## Production checklist for `.env`

- `NODE_ENV=production`
- `COOKIE_SECURE` defaults to true. Use `COOKIE_SAMESITE=lax` if the frontend shares the site (e.g. `www.` and `api.` on one domain). Otherwise use `none` and set `COOKIE_DOMAIN`.
- Three distinct 48-byte secrets (`openssl rand -base64 48`). The app refuses to start with defaults.
- `MONGODB_AUTO_INDEX=false`, then run `npm run sync-indexes` during each deploy.
- `STORAGE_DRIVER=s3` with bucket credentials scoped to one bucket (`s3:PutObject`, `s3:DeleteObject`). Put a CDN in front of `OBJECT_STORAGE_PUBLIC_URL`.
- Razorpay: **live** keys, plus a webhook pointing to `https://api.yourstore.in/api/v1/webhooks/razorpay`. Subscribe the webhook to `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed` and `refund.failed`.

## Deploy / rollback

1. CI: `npm ci && npm test && npm run audit:deps`, then build the image tagged with the git SHA.
2. Run `npm run sync-indexes` once (as a one-off container). Index builds are additive and online.
3. Rolling restart of the API instances. Readiness (`/health/ready`) gates traffic. On `SIGTERM` each instance fails readiness, closes sockets (clients reconnect elsewhere), finishes in-flight requests and closes queues. There is a hard limit of 25 s, so set the load-balancer drain to at least 30 s.
4. Restart the workers.
5. **Rollback**: redeploy the previous image tag. Schema changes are additive. If a release needs a data backfill, ship it as a separate, idempotent script under `scripts/` and run it explicitly. Nothing destructive runs automatically.

## Backups & disaster recovery

- **MongoDB**: Atlas continuous backup (point-in-time, ≥ 7 days) plus daily snapshots kept 35 days. Self-managed alternative: `mongodump --uri "$MONGODB_URI" --oplog --gzip --archive=crockery-$(date +%F).gz`, shipped to a separate account or bucket with object lock.
- **Restore drill (quarterly)**: `mongorestore --uri "$STAGING_URI" --gzip --archive=… --oplogReplay`. Then run `npm run sync-indexes` and smoke-test checkout on staging.
- **Redis** holds no system-of-record data. Losing it drops queued jobs and cached data. Every job is idempotent and the schedulers re-create themselves. After a Redis loss, run `POST /api/v1/admin/payments/reconcile` and `POST /api/v1/admin/replacements/allocate`.
- **Images**: enable bucket versioning plus cross-region replication.
- Targets: RPO ≤ 5 min (PITR), RTO ≤ 1 h.

## Monitoring & alerting

| Signal | Source | Alert when |
|---|---|---|
| Availability, p95/p99 latency, 5xx rate | LB / APM | 5xx > 1 % for 5 min; p99 > 2 s |
| Event-loop delay, RSS | `/health/metrics` | p99 > 200 ms; RSS > 80 % of the memory limit |
| Queue depth / failed jobs | `/health/metrics`, `GET /admin/system/jobs/failed` | failed > 0 for `payments`; waiting > 1,000 |
| Pending UPI older than 30 min, failed webhooks | `GET /admin/payments/reconciliation` | any |
| Mongo replication lag, connections, slow queries | Atlas | lag > 10 s; profiler > 200 ms |
| Redis memory, latency | provider | memory > 75 % |
| Gemini errors / latency / tokens | `GET /admin/analytics/ai-usage` | error rate > 10 % |
| Security | audit log (`auth.refresh_reuse_detected`, `auth.account_locked`, `payment.signature_invalid`) | spikes |

Logs are structured JSON (Pino) on stdout, with correlation by `requestId`. Ship them to your log platform. Recommended retention: application logs 30 days, security and audit exports 1 year.

The `AuditLog` collection is retained indefinitely by default. Archive it to cold storage yearly if needed. TTL indexes clean up webhook events after 90 days, notifications after 180 days, AI usage records after 180 days, and expired OTPs and sessions automatically.

## Secret rotation

| Secret | Procedure | Impact |
|---|---|---|
| `JWT_ACCESS_SECRET` | Replace and roll | Access tokens become invalid. Clients refresh silently |
| `JWT_REFRESH_SECRET` | Replace and roll | Peppers refresh/OTP hashes. **All users must log in again**; pending OTPs fail |
| `COOKIE_SECRET` | Replace and roll | CSRF tokens and guest carts reset (clients re-fetch `/auth/csrf`) |
| Razorpay key / webhook secret | Create new in the dashboard, update env, roll, then revoke the old one | Pending checkouts may need a retry |
| `GEMINI_API_KEY`, SMTP, S3 | Create new, roll, revoke old | None |

## Data retention & deletion

- Customers request deletion with `POST /users/me/delete-request`. After 14 days, `maintenance/anonymize-users` deletes addresses, carts, wishlists and sessions, and removes name, email, phone and password.
- Orders, invoices, payments and refunds are **retained** (Indian GST and accounting rules typically require about 8 years), but linked to an anonymised account.
- Chat messages and uploads should follow your published privacy policy. Configure a retention job if you promise one.
