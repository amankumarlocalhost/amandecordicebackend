# Architecture & business rules

## Shape

This is a **modular monolith** that scales horizontally. API processes are stateless, so N of them can run behind a load balancer. Shared state lives in MongoDB (system of record) and Redis (rate limits, caches, BullMQ queues, the Socket.IO adapter, presence). Background work runs in `src/worker.js`.

```
src/
  app.js / server.js / worker.js     bootstrap, graceful shutdown, health
  config/      env (Zod-validated), logger (redacting), database (transactions w/ backoff), redis, gemini
  middleware/  auth (JWT + DB-checked session), CSRF, sanitize, validate, rate limits, errors
  utils/router.js                    declarative routes → auth/permission/validation + OpenAPI
  services/    cache (versioned namespaces), storage (local/S3), channels (email/SMS/WhatsApp)
  queues/      BullMQ facade (inline fallback in dev/test)     jobs/  processors + schedules
  events/      in-process domain events → notifications          sockets/  Socket.IO server
  modules/     auth users addresses categories collections products media inventory pricing
               promotions cart shipping checkout orders payments refunds returns replacements
               reviews notifications chat ai analytics settings audit admin
```

Route handlers are thin. Business logic lives in `*.service.js`. Every route declares its auth, permission and Zod schemas once, through `createRouter`. That one declaration wires the middleware and also generates the OpenAPI document.

## Money, tax, pricing

- All amounts are **integer paise**. Splits use largest-remainder allocation, so line amounts always sum exactly to the totals.
- Selling prices are **GST-inclusive**. Tax is extracted per line: `round(gross × r / (1 + r))`, at the product's GST rate (default 18%). Shipping, COD and gift-wrap fees are taxed at the default rate.
- `pricing.service.quote()` is the only place amounts are computed. Discounts apply in this order:
  1. **Sale price**: the variant price (≤ MRP).
  2. **One automatic promotion per line**: the best saving for the customer wins. Promotions never stack with each other.
  3. **Coupon**: applied only where both the coupon (`stackableWithPromotions`) and the line's promotion (`stackableWithCoupons`) allow stacking.
  4. **Shipping**: base fee, plus a per-kg charge on chargeable weight (`max(actual, L×W×H/5000)`), plus a fragile surcharge, plus a PIN-code surcharge. Shipping is free above the threshold or when a free-shipping offer applies.
  5. **COD fee and gift wrap**.
- Orders store an **immutable snapshot**: name, SKU, unit price, discounts, tax, return policy and bundle components.

## Inventory (per SKU)

`onHand`, `reserved` (`available = onHand − reserved`), `quarantine`, `damaged`, `unusable`, `sold`. Each change writes an `InventoryMovement`.

- Every mutation is a **single-document conditional `$inc`**, e.g. reserve only if `onHand − reserved ≥ q`. Multi-SKU operations run in a transaction, so they are all-or-nothing.
- UPI orders reserve stock for `checkout.reservationMinutes` (15). The hold is committed on payment, and released on expiry or cancellation. COD orders take stock immediately.
- Bundles hold no stock of their own. They reserve their component SKUs, and their availability is `min(floor(component available / qty))`.
- Returned and RTO units go to **quarantine** and are never resold automatically. An inspection decision is required: `restock`, `damaged` or `unusable`.
- Writes to hot documents (a popular SKU, a coupon counter) come last in the checkout transaction. Write conflicts are retried with jittered backoff.

## State machines (validated, race-safe)

Each transition is a conditional update on the current status, so two concurrent writers cannot both move an order.

**Order**
```
pending → confirmed | cancelled
confirmed → processing | packed | cancelled
processing → packed | cancelled
packed → shipped | cancelled
shipped → out_for_delivery | delivered | delivery_failed | returned_to_origin
out_for_delivery → delivered | delivery_failed
delivery_failed → out_for_delivery | shipped | returned_to_origin
returned_to_origin → cancelled                       (stock → quarantine)
delivered → return_requested | replacement_processing | completed
```
Customers can cancel until the order is **packed**.

**Payment status** is tracked separately from order status: `pending, paid, failed, partially_refunded, refunded, cod_due, cod_collected, cod_not_collected`.

**Return/replacement**
```
requested → awaiting_review | approved | rejected
approved → pickup_scheduled → item_received → inspection → resolved → closed
approved → resolved                                  (no pickup needed, e.g. broken glass with photos)
```
Rejected or cancelled claims release their units.

**Refund**
```
pending_approval → approved → processing → processed | failed
COD refunds start at awaiting_destination (customer supplies a UPI ID or bank account; staff pay out manually)
```

## Payments (UPI via Razorpay, COD)

1. `place-order` creates the order, the stock hold and a Razorpay order. It returns Checkout options restricted to **UPI** (other methods hidden).
2. The browser callback is verified with an HMAC signature. The server then **fetches the payment from Razorpay** and checks that the amount, currency and method are `upi`.
3. Webhooks are verified with an HMAC over the **raw body** and deduplicated by event id (`WebhookEvent`). The payment document is claimed with a conditional update, so signature callbacks, webhooks and reconciliation can all deliver the same capture and it is **processed exactly once**.
4. A reconciliation job (every 60 s) pulls the true state of pending orders and expires unpaid ones.
5. A capture that arrives after expiry or stock-out, or a non-UPI capture, is **refunded automatically**.
6. Refunds reserve capacity on the order (`refundCommitted ≤ total`), so over-refunding is impossible.
7. Provider refunds embed our refund id in the notes, and retries check for an existing refund before creating one.
8. COD is marked collected only by `payments:cod` staff, once, and only for the exact total. Remittances are recorded separately.

## Returns policy engine (crockery-specific)

- **Transit damage** (broken, chipped, shipping damage, missing piece) must be reported within `damageReportWindowDays` (default 3) of delivery. Other reasons (wrong item or colour, not as described, defective) use the item's return window (default 7 days). Change-of-mind returns are off by default.
- Photos are required for damage, wrong-item and not-as-described claims.
- **Auto-approval** happens only when all of these hold:
  - The reason is eligible.
  - Photos are present.
  - The claim value is ≤ `autoApproveMaxValue` (₹2,000).
  - The order is not high-value.
  - The customer has fewer than 3 claims in 90 days.

  Everything else goes to staff review, with reasons recorded.
- Units are claimed atomically per order item (`claimedQty`), so duplicate claims or duplicate replacements are impossible. A unique index ties each replacement to its claim.
- Replacements never charge the customer. Missing set components are replaced component by component.

## AI (Google Gemini only)

- **Controlled tool calling.** Gemini can only request named tools. The server validates every argument against a **strict Zod schema**, re-checks permissions, and derives identity from the session (no tool accepts a user id). Tools run with timeouts and return minimised data. The model gets no database access, no raw queries and no other customers' data.
- **Untrusted data.** Product text arrives as `descriptionUntrusted`, and the system prompts tell the model to treat all tool data as data.
- **Proposals.** Consequential actions (returns, replacements, cancellations, coupons, price/stock changes, campaigns, product drafts, support replies) become **proposals**. A human with authority confirms the proposal. The executor re-runs all business rules, the claim is atomic, and the proposal id is the idempotency key.
- **Admin assistant.** It sees only the tools its role permits. Confirmation re-checks the *confirming* admin's permission.
- **Reliability.**
  - Timeouts, plus retries with jitter for transient failures (429/5xx).
  - A process-wide concurrency limit.
  - Daily per-user quotas.
  - Rolling conversation summaries keep prompts short.
  - A usage record for every call (tokens, latency, tools; no message text).
  - A kill switch in `settings.ai`.
  - Deterministic fallback (search + FAQ + human handoff) whenever Gemini is unavailable.

## Metric definitions (analytics)

- **Confirmed order**: `confirmedAt` is set. That happens at placement for COD and at payment capture for UPI.
- **GOV**: the sum of totals of orders confirmed in the range, including orders later cancelled.
- **Net order value**: GOV minus cancelled value.
- **Collected revenue**: UPI captured in the range plus COD cash collected in the range. **Unpaid COD is never revenue.**
- **Net collected revenue**: collected revenue minus refunds processed in the range.
- **AOV**: GOV ÷ confirmed orders.
- **Claim rate**: claims ÷ confirmed orders. Damage claims are also reported per SKU against units sold.

Reports are bounded to 366 days and cached for 5 minutes.
