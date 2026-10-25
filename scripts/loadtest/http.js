'use strict';

/**
 * HTTP load test with realistic traffic shapes. Run against a dev/staging server whose rate
 * limits are raised for the test (they are per-IP and would otherwise throttle a single client):
 *
 *   RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000000 npm run dev:memory   # terminal 1
 *   BASE_URL=http://localhost:4000 npm run loadtest:http                     # terminal 2
 *
 * Options: DURATION (s, default 20), CONNECTIONS (default 100), USERS (default 40),
 *          SCENARIOS=browse,product,search,cart,checkout,login
 * Never point this at production.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const autocannon = require('autocannon');
const { BASE, api, makeCustomer, pool, summarize } = require('./common');

const DURATION = Number(process.env.DURATION || 20);
const CONNECTIONS = Number(process.env.CONNECTIONS || 100);
const USERS = Number(process.env.USERS || 40);
const SCENARIOS = (process.env.SCENARIOS || 'browse,product,search,cart,checkout,login').split(',');

const run = (opts) => new Promise((resolve, reject) => autocannon({ url: BASE, duration: DURATION, connections: CONNECTIONS, ...opts }, (err, res) => (err ? reject(err) : resolve(res))));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const products = (await api('GET', '/api/v1/products?limit=50')).body.data || [];
  if (!products.length) throw new Error('No products: seed the catalog first (npm run seed -- --with-stock)');
  const categories = ((await api('GET', '/api/v1/categories')).body.data || []).flatMap((c) => [c.slug, ...c.children.map((x) => x.slug)]);
  const results = [];

  if (SCENARIOS.includes('browse')) {
    results.push(
      summarize(
        'browse: listing/filter pages',
        await run({
          requests: [{ setupRequest: (r) => ({ ...r, method: 'GET', path: `/api/v1/products?category=${pick(categories)}&sort=${pick(['popularity', 'price_asc', 'newest'])}&page=1&limit=24` }) }],
        }),
      ),
    );
  }
  if (SCENARIOS.includes('product')) {
    results.push(summarize('product detail (live stock)', await run({ requests: [{ setupRequest: (r) => ({ ...r, method: 'GET', path: `/api/v1/products/${pick(products).slug}` }) }] })));
  }
  if (SCENARIOS.includes('search')) {
    const terms = ['dinner set', 'glass', 'mug', 'bone china', 'whiskey', 'jar', 'vase', 'cutlery', 'gift'];
    results.push(summarize('full-text search', await run({ requests: [{ setupRequest: (r) => ({ ...r, method: 'GET', path: `/api/v1/search?q=${encodeURIComponent(pick(terms))}` }) }] })));
  }

  let customers = [];
  if (SCENARIOS.some((s) => ['cart', 'checkout'].includes(s))) {
    console.log(`registering ${USERS} customers…`);
    customers = await pool(USERS, 8, makeCustomer);
    const skus = products.filter((p) => p.inStock && p.type === 'simple').map((p) => p.defaultSku);
    for (const c of customers) await api('POST', '/api/v1/cart/items', { token: c.token, body: { sku: pick(skus), quantity: 1 } });
    if (SCENARIOS.includes('cart')) {
      results.push(summarize('cart view with server-side pricing (authenticated)', await run({ requests: [{ setupRequest: (r) => ({ ...r, method: 'GET', path: '/api/v1/cart', headers: { authorization: `Bearer ${pick(customers).token}` } }) }] })));
    }
    if (SCENARIOS.includes('checkout')) {
      // Each iteration: add one unit to the cart, then place a COD order (reserve + commit stock in a transaction).
      const cheap = products.filter((p) => p.inStock && p.type === 'simple').sort((a, b) => a.priceMin - b.priceMin).slice(0, 5).map((p) => p.defaultSku);
      let ci = 0;
      results.push(
        summarize(
          'checkout: add-to-cart + place COD order',
          await run({
            connections: Math.min(CONNECTIONS, customers.length),
            requests: [
              {
                setupRequest: (r, ctx) => {
                  ctx.c = customers[ci++ % customers.length];
                  return { ...r, method: 'POST', path: '/api/v1/cart/items', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.c.token}` }, body: JSON.stringify({ sku: pick(cheap), quantity: 1 }) };
                },
              },
              {
                setupRequest: (r, ctx) => ({
                  ...r,
                  method: 'POST',
                  path: '/api/v1/checkout/place-order',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.c.token}`, 'idempotency-key': crypto.randomUUID() },
                  body: JSON.stringify({ addressId: ctx.c.addressId, paymentMethod: 'cod' }),
                }),
              },
            ],
          }),
        ),
      );
    }
  }
  if (SCENARIOS.includes('login')) {
    if (!customers.length) customers = await pool(Math.min(USERS, 20), 8, makeCustomer);
    results.push(
      summarize(
        'login burst (bcrypt-bound)',
        await run({
          connections: Math.min(CONNECTIONS, 50),
          requests: [{ setupRequest: (r) => ({ ...r, method: 'POST', path: '/api/v1/auth/login', headers: { 'content-type': 'application/json', 'x-client-type': 'mobile' }, body: JSON.stringify({ identifier: pick(customers).email, password: 'LoadTest123' }) }) }],
        }),
      ),
    );
  }

  const metrics = (await api('GET', '/health/metrics')).body;
  const report = { at: new Date().toISOString(), base: BASE, node: process.version, durationSec: DURATION, connections: CONNECTIONS, results, serverAfter: metrics };
  const dir = path.resolve(__dirname, '../../loadtest-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `http-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.table(results.map((r) => ({ scenario: r.scenario, conns: r.connections, rps: r.rpsAvg, p50: r.latencyMs.p50, p90: r.latencyMs.p90, p99: r.latencyMs.p99, non2xx: r.non2xx, errors: r.errors })));
  console.log(`saved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
