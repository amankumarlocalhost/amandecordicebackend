# Admin panel integration

How the three apps work together, what the admin panel can change, and how changes reach the
storefront. Full request/response schemas are in `openapi.json` (served at `/api/docs`).

```
Admin panel (Next.js, :3001) ──HTTPS + HttpOnly cookies + CSRF──▶ Backend API (Express, :4000) ──▶ MongoDB / media storage
                                                                     │  after commit:
                                                                     ├─ POST tags ─▶ Storefront /api/revalidate (server cache)
                                                                     └─ emit ─────▶ Socket.IO /public ─▶ open storefront tabs refresh
Storefront (Next.js, :3000) ◀── public, published-only API reads (tag-cached) ──┘
```

## Feature → API → data → storefront map

| Admin module | Permission(s) | Main endpoints | Collections | Storefront surface | Sync event / cache tags |
|---|---|---|---|---|---|
| Dashboard | per tile | `GET /admin/overview`, `/admin/analytics/sales`, `/admin/orders`, `/admin/inventory` | all | — | — |
| Products | `catalog:read` / `catalog:write`, `pricing:write`, `catalog:cost` | `GET/POST /admin/products`, `GET/PATCH /admin/products/:id`, `POST /:id/status`, `POST /bulk`, `GET /counts`, `PATCH /:id/images`, `PATCH /:id/videos`, `POST /:id/images/:imageId/replacement`, `…/replacement/publish`, `DELETE …/replacement`, `POST …/rollback` | `products`, `inventories`, `uploads` | `/products/[slug]`, listings, search, homepage rails | `product:published` / `product:updated` / `product:unpublished`; `catalog`, `product:<slug>` |
| Media library & review | `catalog:read` (view), `catalog:write` / `content:write` / `promotions:write` (upload), `media:review` (approve/reject) | `POST /admin/media`, `GET /admin/media`, `GET /admin/media/stats`, `GET /admin/media/:id`, `POST /:id/approve`, `POST /:id/reject`, `POST /admin/media/review` (bulk), `DELETE /admin/media/:id`, `GET /media/preview/:id/:size` (signed) | `uploads` | images everywhere (only after approval and only where attached to published records) | via the record that uses the image |
| Categories | `catalog:*` | `GET/POST /admin/categories`, `PATCH/DELETE /admin/categories/:id` | `categories` | navigation, `/category/[slug]`, filters | `category:updated`; `categories`, `catalog` |
| Collections | `catalog:*` | `GET/POST /admin/collections`, `PATCH/DELETE /:id`, `PUT /:id/products` | `collections`, `products.collections` | homepage featured collections, `/collections` | `collection:updated`; `collections`, `catalog` |
| Homepage & layout (CMS) | `content:write` | `GET /admin/content`, `GET /admin/content/:key`, `PUT /:key/draft`, `POST /:key/publish`, `/discard`, `/rollback`, `/preview-token`; public `GET /content/:key`, `GET /content/:key/preview?token=` | `sitecontents` (`homepage`, `footer`, `announcement`, `navigation`) | hero, category tiles, editorial sections, section order/visibility, footer, menu, announcement bar | `homepage:updated` / `content:updated`; `content:<key>` |
| Pages | `content:write` | `GET/POST /admin/pages`, `GET /admin/pages/:id`, `PUT /:id/draft`, `POST /:id/publish`, `/unpublish`, `/preview-token`, `DELETE /:id`; public `GET /pages`, `GET /pages/:slug` | `pages` | `/pages/[slug]`, footer links, sitemap | `page:updated`; `pages`, `page:<slug>` |
| Promotions | `promotions:read` / `promotions:write` | `/admin/campaigns`, `/admin/promotions`, `/admin/coupons` (+ `/:id/activate`, `/:id/pause`, `/coupons/:id/redemptions`) | `campaigns`, `promotions`, `coupons` | homepage promo banner, prices, checkout | `promotions:updated`, `banner:updated`; `promotions`, `catalog` |
| Inventory | `inventory:read` / `inventory:write` | `GET /admin/inventory`, `GET /:sku`, `POST /:sku/adjust`, `/damage`, `/disposition`, `PATCH /:sku/threshold` | `inventories`, `inventorymovements` | stock status, "in stock" filters | `inventory:updated` (only when a published product flips in/out of stock); `catalog`, `product:<slug>` |
| Orders | `orders:read` / `orders:write`, `shipments:write`, `payments:cod` | `GET /admin/orders`, `GET /:id`, `POST /:id/status`, `/rto-received`, `/notes`, `POST /admin/orders/:id/shipments`, `POST /admin/shipments/:id/events`, `POST /admin/payments/cod/:orderId/collected` | `orders`, `shipments`, `payments` | customer order pages, notifications | customer notifications (existing) |
| Returns / refunds / payments | `returns:*`, `refunds:*`, `payments:read` | `/admin/returns…`, `/admin/refunds…`, `/admin/payments…` | `returnrequests`, `refunds`, `payments` | customer returns pages | — |
| Reviews & Q&A | `reviews:moderate` | `GET /admin/reviews`, `POST /:id/moderate`, `GET /admin/questions`, `POST /:id/answer` | `reviews`, `productquestions` | product ratings, testimonials | `product:updated` when a published product's rating changes |
| Customers / staff | `customers:*`, `staff:manage` | `/admin/customers…`, `/admin/staff…` | `users` | — | — |
| Settings | `settings:write` (all), `ai:settings` (AI only) | `GET /admin/settings`, `PATCH /admin/settings/:section` | `businesssettings` | announcement bar, feature strip, help pages, checkout | `content:updated`; `settings` |
| Audit / system | `audit:read`, `jobs:manage` / `settings:write` | `GET /admin/audit-logs`, `GET /admin/system/status`, `/jobs`, `/jobs/failed`, `/errors` | `auditlogs`, `errorlogs` (capped) | — | — |

Roles: `catalog_manager` gained `media:review` and `content:write`; `marketing_manager` gained `content:write`; `super_admin` has everything.

## Image review workflow

```
upload ──▶ pending_review (private) ──approve──▶ approved (public URL) ──attached to a published record──▶ visible on store
                         └──reject (reason, optional "request replacement")──▶ rejected (stays private) ──re-upload──▶ pending_review
approved image replaced & new one published ──▶ superseded (kept for rollback) ──after MEDIA_RETENTION_DAYS, if unused──▶ deleted
```

- Uploads are decoded by Sharp (the MIME type is not trusted), EXIF/GPS stripped, re-encoded to WebP in three sizes (or one Cloudinary master), and stored **privately**: `uploads-private/` locally, the `private/` prefix on S3, `type=authenticated` on Cloudinary. A pending file has **no public URL**.
- Admins preview pending files through short-lived signed links (`MEDIA_PREVIEW_TTL_SEC`, HMAC over id + size + expiry; Cloudinary uses its own signed delivery URLs).
- Approval claims the record atomically, moves the files to public storage, then fills the public URLs into every product gallery entry that references the upload. If storage fails, approval is rolled back.
- Reviewers cannot approve their own uploads unless they are `super_admin`.
- Product galleries may hold pending images (shown to admins as "in review · hidden"); every public serializer filters them out. Publishing requires at least one approved image.
- Categories, collections, campaign banners and CMS content accept **approved media only**; URLs always come from the media record, never from the client.
- **Replacing a live product image** stages the new upload on that gallery entry. The old image stays live through review; "Publish replacement" swaps it in one conditional update and keeps the old asset for rollback.
- **Legacy images** (plain URLs on records created before this workflow) are grandfathered: they stay as long as the entry is unchanged; any new image must be an approved upload. `MEDIA_EXTERNAL_HOSTS` can allow specific external hosts (development/demo data only — leave empty in production).
- Media still referenced anywhere (product, category, collection, banner, content, page) cannot be deleted. The `cleanup-media` job (every 6 h) deletes rejected / never-reviewed / superseded media older than `MEDIA_RETENTION_DAYS` only when unused.

## Storefront synchronisation

1. A service commits the change to MongoDB.
2. It calls `sync.changed({ tags, events })` (`src/services/sync.js`). Changes are coalesced for ~120 ms.
3. The backend POSTs the tags to `FRONTEND_REVALIDATE_URL` with `x-revalidate-secret` (3 attempts). The storefront route `app/api/revalidate` calls `revalidateTag(tag, { expire: 0 })`.
4. Then it emits the events on the Socket.IO `/public` namespace. Payloads carry identifiers only: `{ event, id?, slug?, key?, at, v }`. Drafts and non-public states are never announced.
5. `components/layout/LiveUpdates.js` in the storefront listens (no login; separate connection from the customer chat socket), decides whether the event affects the current page, and calls `router.refresh()` (debounced 400 ms). It refreshes once after reconnecting and when a hidden tab becomes visible.

Measured on the isolated local stack (production builds, in-memory MongoDB): an open storefront tab received `product:published` **~150 ms** after the publish request; fresh product pages, cached listings and the homepage hero were served **220–300 ms** after publish/edit. Real deployments add network latency; the design target is 1–3 s.

Public `/public` namespace security: origin allow-list (`FRONTEND_URL`), no client handlers (anything a visitor emits is ignored), no data beyond identifiers.

Without `FRONTEND_REVALIDATE_URL`, the storefront still updates when its short caches expire (≈1 minute), and open tabs still receive events.

## Consistency rules

- `PATCH /admin/products/:id` and `POST /:id/status` accept `expectedUpdatedAt`; a newer stored version returns `409 STALE_WRITE` (the admin editor always sends it).
- CMS drafts use `baseVersion` and publishing sends the exact `version` that was saved, so nobody publishes something they have not seen.
- Bulk actions (`/admin/products/bulk`, `/admin/media/review`) need `confirm: true` and report each item separately.
- Payment status cannot be edited from the admin panel. It changes only through verified Razorpay callbacks/webhooks, reconciliation, or recorded COD collection (`payments:cod`, exact amount, once).
- Every admin write is audited (`audit_logs`); unexpected 5xx errors are recorded in the capped `errorlogs` collection and shown on System health.

## Environment variables

**Backend (`backend/.env`)** — new:

| Variable | Purpose |
|---|---|
| `FRONTEND_URL` | Must list both the storefront and the admin origins (CORS + Socket.IO) |
| `FRONTEND_REVALIDATE_URL` | Storefront revalidation endpoint, e.g. `https://www.yourstore.in/api/revalidate` |
| `REVALIDATE_SECRET` | 32+ random characters, shared with the storefront (required in production when the URL is set) |
| `MEDIA_PREVIEW_TTL_SEC` | Signed preview lifetime (default 600) |
| `MEDIA_MIN_DIMENSION` | Minimum image side in px (default 200) |
| `MEDIA_RETENTION_DAYS` | Cleanup age for unused rejected/superseded media (default 30) |
| `MEDIA_EXTERNAL_HOSTS` | Allow-listed external image hosts (empty in production) |

**Storefront (`.env.local`)**: `REVALIDATE_SECRET` (server-only, same value as the backend).

**Admin (`.env.local`)**: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SOCKET_URL` (optional), `NEXT_PUBLIC_STOREFRONT_URL`, `NEXT_PUBLIC_STORE_NAME`. No secrets.

## Running locally

```bash
# 1. Backend (your .env) — or `npm run dev:memory` for a throwaway in-memory database with demo data
cd backend && npm run dev                      # :4000

# 2. Storefront
cd crockery-frontend/crockery-frontend && npm run dev   # :3000

# 3. Admin panel
cd crockery-admin/crockery-admin && npm install && npm run dev   # :3001
```

Create the first admin with `npm run create-admin` in `backend/` (or use the `dev:memory` demo admin printed at startup).

## Deploying

- Serve the admin on a subdomain of the same site as the API (e.g. `admin.yourstore.in` + `api.yourstore.in`), set `COOKIE_DOMAIN=.yourstore.in`, `COOKIE_SECURE=true`, and add the admin origin to `FRONTEND_URL`.
- Use `STORAGE_DRIVER=cloudinary` or `s3`. For S3, deny public reads on `private/*` in the bucket policy.
- Set `FRONTEND_REVALIDATE_URL` + `REVALIDATE_SECRET` on the backend and the same secret on the storefront.
- With several API instances, set `REDIS_URL`: the Socket.IO Redis adapter fans `/public` events out across instances and the worker reaches clients through the Redis emitter.
- After deploying, run `npm run sync-indexes` (new indexes on uploads, products, site contents and pages).
