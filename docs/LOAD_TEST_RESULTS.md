# Load test results

## Setup and caveats (read first)

- **Machine**: one Windows 11 development PC with 16 logical CPUs and Node 24.21.
- **Same box for everything**: the API, MongoDB, *and* the load generator all ran on this one machine.
  - MongoDB was the in-memory single-node replica set (`npm run dev:memory`).
  - Redis was absent, so the cache and queues ran in-process.
  - The API was **one Node process**.
- **Rate limits** were raised for the run: they are per-IP, and all traffic came from one IP.
- **Data**: the seeded catalog (13 products).
- **What this is**: an engineering baseline for one instance. It is **not** a capacity guarantee for production. Production adds network hops, a real MongoDB (Atlas), Redis and multiple instances.
- **Before launch**: rerun these scripts against staging that mirrors production: `BASE_URL=https://staging… npm run loadtest:http` and `loadtest:sockets`.
- Raw JSON for each run is in `loadtest-results/`.

## HTTP: 100 concurrent connections, 20 s per scenario (`npm run loadtest:http`)

| Scenario | Connections | Req/s | p50 ms | p90 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| Browse listing/filter pages (cached) | 100 | **6,808** | 13 | 18 | 26 | 0 |
| Product detail (live stock read) | 100 | **1,703** | 57 | 64 | 78 | 0 |
| Full-text search | 100 | **5,512** | 17 | 21 | 29 | 0 |
| Cart view with full server-side pricing | 100 | **438** | 227 | 250 | 302 | 0 |
| Add-to-cart + place COD order (transaction) | 60 | **72** | 292 | 3,327 | 4,751 | 0 |
| Login burst (Argon2id) | 50 | **94** | 522 | 559 | 691 | 0 |

- **Checkout non-2xx responses (591) were all business rejections**, because the 5 cheapest SKUs sold out during the run (`OUT_OF_STOCK` / `CHECKOUT_BLOCKED`). They were not failures.
- **No overselling**: after the run, every SKU satisfied `0 ≤ reserved ≤ onHand`, with 258 confirmed orders.
- **Server at the end of the run**: event-loop delay p50 28 ms / p99 57 ms, RSS 502 MB, heap 100 MB, 0 failed jobs.

## Socket.IO: 1,000 concurrent connections (`npm run loadtest:sockets`)

25 accounts × 40 sockets each (simulating multiple tabs or devices). Every socket joined its account's conversation, then **all 1,000 sockets sent 3 messages at once**.

| Metric | Result |
|---|---|
| Connected / failed | **1,000 / 0** |
| Connect latency p50 / p95 / p99 | 31 / 48 / 56 ms |
| Conversation join (history read) p95 | 891 ms (all 1,000 joined simultaneously) |
| Messages sent / acknowledged / timed out | 3,000 / 3,000 / 0 |
| Message throughput | 379 messages/s |
| Ack latency p50 / p99 | 2,547 / 2,822 ms |

The ack latency reflects a deliberately harsh case:

- 3,000 messages were burst into only 25 conversations, so each conversation document was rewritten about 120 times concurrently.
- Each message fanned out to the 40 sockets in its room, for about 120,000 emits in total.

Real support traffic, with one conversation per customer and a few messages a minute, is far below this.

## Changes made because of these tests

The first runs exposed real problems, which were fixed and re-measured.

1. **bcryptjs blocked the event loop.** A 50-login burst caused 50/50 timeouts. Password hashing moved to native Argon2id on the libuv thread pool, and the same burst now has 0 errors at p99 691 ms.
2. **Every order invalidated the whole catalog cache**, through the stock-refresh job. Stock refreshes are now debounced per SKU, and the cache is invalidated only when a product's in-stock flag flips. Browse throughput went from 2,081 to 6,808 req/s.
3. **Checkout write-conflict storms** on hot SKUs gave 11 req/s, p99 9.1 s and 53 timeouts. Three changes fixed this:
   - Transactions now retry write conflicts with jittered backoff.
   - Hot documents (coupon counter, SKU stock) are written last in the transaction.
   - COD takes stock in a single guarded update.

   The result is 72 req/s with 0 errors.
4. **The OTP rate limiter keyed every verification by IP.** It now keys by user.

## What the "1,000 concurrent sessions" target means

These are different workloads, and they are measured separately:

- **1,000 concurrent sessions** is browsing customers. At a typical 1 request per 5–10 s per shopper, that is about 100–200 req/s, mostly cached reads. One instance sustained more than 30 times that.
- **1,000 concurrent sockets**: verified above on a single instance.
- **Checkout bursts** (festival flash sales) are bound by MongoDB write contention on the same SKUs, not by Node. The measured 72 orders/s on one hot set of SKUs is about 260,000 orders per hour.
- **Scaling path**:
  - Add API instances behind the load balancer (stateless; Redis provides shared state).
  - Run a separate worker.
  - Use Atlas M30 or larger.
  - Keep `GEMINI_MAX_CONCURRENCY` sized to your Gemini quota.
- **AI traffic was not load-tested.** It is bounded by Gemini quotas and latency, and protected by the concurrency limit, quotas and fallback. Measure it against your real quota with a staging key.
