# Status: what's done, what's not, what needs credentials

## Verified

- **119 automated tests pass** across 11 suites (October 2026, including the admin-panel suite: media review, publishing rules, image replacement/rollback, CMS drafts/publishing, optimistic concurrency, revalidation webhooks and the public real-time channel). Earlier releases documented 95. They run against a real MongoDB replica set (in-memory), so transactions, unique indexes and TTL behaviour are exercised. Razorpay and Gemini are replaced by in-memory fakes, and no live provider is called.
- **Coverage by area**:
  - **Auth**: registration, OTP expiry/attempts/cooldown, lockout, CSRF, refresh rotation and reuse detection, logout and password-change revocation, password reset, role-based access, staff/customer login separation.
  - **Catalog**: filters, search, facets, variant validation, cost-price restriction, bundle availability.
  - **Inventory**: 12 concurrent buyers for the last unit (exactly one wins), all-or-nothing multi-SKU holds, idempotent release, bundle components, quarantine and disposition.
  - **Checkout**: invalid quantities, ignored client prices, GST/shipping/COD maths, coupon caps and minimums, promotion and coupon stacking, campaign pause, UPI/COD-only, idempotency under concurrent duplicates, price snapshots, stale-price detection, stock blocking, verified phone for COD, concurrent coupon redemption, cancellation restocking.
  - **Payments**: UPI-only options, exactly-once confirmation, bad signatures, cross-customer verification, forged and duplicate webhooks, failed payment and retry, reconciliation, expiry, late-payment and non-UPI auto-refunds, transient refund retry without double refunds, refund webhooks, over-refund prevention, approval limits, COD collection and RTO quarantine, invalid transitions.
  - **Returns**: fake-image rejection, the broken-glass auto replacement through to delivery, concurrent duplicate claims, idempotency keys, photos required, expired windows, change-of-mind policy, missing set component, high-value review with finance approval, UPI damage refund, pickup → inspection → restock, ownership, rejection releasing units.
  - **AI**: grounded product answers, cross-customer isolation, invalid, injected and unknown tool calls, untrusted product text, proposal → confirm exactly once, photo requirement, timeout and 429 fallback, kill switch, admin role-limited tools, confirmation permission re-check.
  - **Sockets**: unauthenticated and foreign-origin rejection, conversation isolation, reconnect dedupe (one AI reply), handoff, typing, read receipts, real-time notifications, rate limiting, size limits.
  - **Engagement**: verified-purchase reviews, moderation and rating, notifications, back-in-stock, analytics revenue definitions, report permissions.
- **Admin panel end-to-end** (production builds of storefront and admin, in-memory MongoDB): 36/36 live checks â€” private pending uploads, signed previews, publish blocked until approval, open storefront tab receives `product:published` in ~150 ms, fresh pages within 220â€“300 ms of publish/edit, CMS preview + publish, unpublish removal. See ADMIN_INTEGRATION.md.
- **Load tests** were measured on one development machine. See LOAD_TEST_RESULTS.md.
- `npm audit --omit=dev`: 0 vulnerabilities.

## Integrations that need credentials or manual setup

| Integration | State | To enable |
|---|---|---|
| **Razorpay UPI** | Code complete. Tested against an SDK-shaped fake; **never run against Razorpay** | Activate UPI on the Razorpay account. Set `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`. Add the webhook URL and events (DEPLOYMENT.md). Do a ₹1 end-to-end test in Test Mode, then a live smoke test. Confirm that your account's Checkout honours the UPI-only `method`/`config.display` options (the server rejects and refunds non-UPI captures either way) |
| **Google Gemini** | Code complete. Tested with a scripted fake; **never run against Gemini** | Set `GEMINI_API_KEY` (and a model id your project can use). Review the prompts and tool behaviour on staging with real conversations before enabling for customers |
| **Object storage (S3/R2/MinIO)** | Adapter written; only the local driver has been exercised | Set `STORAGE_DRIVER=s3` and the `OBJECT_STORAGE_*` values. Upload one image to verify |
| **Email (SMTP)** | Nodemailer adapter; unexercised | Set `SMTP_*`. Transactional emails (verification, reset, orders) go to **verified** addresses only |
| **SMS / WhatsApp** | Interface plus a development-only console adapter. **No real provider** | Implement `sendSms` / `sendWhatsApp` in `src/services/channels.js` for your provider (MSG91, Gupshup, Twilio, …), with DLT-registered templates for India. Phone OTP delivery depends on this |
| **Couriers** | `manual` adapter (staff enter AWB numbers); shipment events entered by staff | Implement the `createShipment/track/cancel` interface in `src/modules/shipping/couriers.js` for Shiprocket or Delhivery, and add a tracking-webhook route |
| **Redis / BullMQ / Socket.IO Redis adapter** | Code complete. **Not exercised here** (no Redis on the dev machine; tests use the inline fallback) | Run the stack with Redis (docker-compose) and repeat the socket load test across two API instances |
| **Docker images** | Dockerfile and compose written, **not built** here | Build in CI |

## Known limitations / deliberate scope cuts

- **Cancellations**: whole-order only. Single-item cancellation and partial shipments are not supported.
- **Returns**: one claim covers units of a single order; there is no multi-order claim.
- **Free-gift promotions and "buy X get Y"** are not implemented. Percentage, fixed and free-shipping offers are, at product, category, brand, collection and cart level. Bundles carry their own price.
- **Store credit**: not implemented (not explicitly requested).
- **COD refunds** are paid out manually by staff, who record the reference. RazorpayX payouts are not integrated.
- **AI assistant photos**: the assistant does not look at images. Photos go to staff review and serve as evidence for policy rules.
- **Search**: MongoDB text plus prefix indexes. Move to Atlas Search or Meilisearch if the catalog grows to tens of thousands of SKUs or needs typo tolerance.
- **Tax**: the invoice endpoint returns GST-inclusive breakdown data, not a GST e-invoice (IRN). The CGST/SGST/IGST split by place of supply is not computed.
- **Shipping**: delivery estimates are working-day arithmetic, not courier quotes.
- **Recently-viewed products** are not stored server-side (the frontend can keep them).
- **Production readiness**: by the brief's own criteria, the system is **not production-ready until** these are done:
  - Provider credentials are configured and tested end to end.
  - Load tests are rerun on staging infrastructure.
  - The operator items in SECURITY.md are completed.
