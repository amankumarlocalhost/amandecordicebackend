'use strict';

const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://localhost:4000';

/** Minimal JSON client using Bearer tokens (no cookies/CSRF needed for non-browser clients). */
async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-client-type': 'mobile', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

/** Registers a customer, verifies the phone (dev server exposes the OTP) and adds an address. */
async function makeCustomer(i) {
  const email = `load${Date.now()}${i}${crypto.randomBytes(2).toString('hex')}@example.com`;
  const phone = `9${String(crypto.randomInt(100000000, 999999999))}`;
  const reg = await api('POST', '/api/v1/auth/register', { body: { name: `Load User${i}`, email, phone, password: 'LoadTest123' } });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  const token = reg.body.data.accessToken;
  if (reg.body.data.devCode) await api('POST', '/api/v1/auth/otp/verify-phone', { token, body: { code: reg.body.data.devCode } });
  const addr = await api('POST', '/api/v1/addresses', { token, body: { fullName: 'Load User', phone: '9876543210', line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' } });
  return { email, token, addressId: addr.body.data?._id };
}

async function pool(n, concurrency, fn) {
  const out = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

function summarize(name, r) {
  return {
    scenario: name,
    connections: r.connections,
    durationSec: r.duration,
    requests: r.requests.total,
    rpsAvg: Math.round(r.requests.average),
    latencyMs: { p50: r.latency.p50, p90: r.latency.p90, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max },
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
  };
}

module.exports = { BASE, api, makeCustomer, pool, summarize };
