'use strict';

/**
 * Socket.IO concurrency test: opens SOCKETS authenticated connections (spread over USERS accounts,
 * like multiple tabs/devices), joins each user's support conversation, then every socket sends
 * MESSAGES chat messages and waits for the acknowledgement.
 *
 *   SOCKETS=1000 USERS=25 MESSAGES=3 BASE_URL=http://localhost:4000 npm run loadtest:sockets
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const { BASE, makeCustomer, pool } = require('./common');

const SOCKETS = Number(process.env.SOCKETS || 1000);
const USERS = Number(process.env.USERS || 25);
const MESSAGES = Number(process.env.MESSAGES || 3);

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

function connect(token) {
  const started = performance.now();
  const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { origin: process.env.ORIGIN || 'http://localhost:3000' } });
  return new Promise((resolve) => {
    s.on('connect', () => resolve({ s, ms: performance.now() - started }));
    s.on('connect_error', (e) => resolve({ s, error: e.message }));
  });
}

const emit = (s, ev, data) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const timer = setTimeout(() => resolve({ ok: false, timeout: true, ms: 10000 }), 10000);
    s.emit(ev, data, (ack) => {
      clearTimeout(timer);
      resolve({ ...ack, ms: performance.now() - t0 });
    });
  });

async function main() {
  console.log(`creating ${USERS} customers…`);
  const users = await pool(USERS, 8, makeCustomer);
  console.log(`opening ${SOCKETS} sockets…`);
  const conns = await pool(SOCKETS, 50, (i) => connect(users[i % USERS].token));
  const ok = conns.filter((c) => !c.error);
  const convIds = {};
  for (let i = 0; i < ok.length; i++) {
    const u = i % USERS;
    if (!convIds[u]) convIds[u] = (await emit(ok[i].s, 'chat:start', { channel: 'human' })).data.conversation.id;
  }
  const joins = await Promise.all(ok.map((c, i) => emit(c.s, 'chat:join', { conversationId: convIds[i % USERS] })));
  const t0 = performance.now();
  const acks = (
    await Promise.all(
      ok.map(async (c, i) => {
        const out = [];
        for (let m = 0; m < MESSAGES; m++) out.push(await emit(c.s, 'chat:message', { conversationId: convIds[i % USERS], clientMessageId: crypto.randomUUID(), body: `load message ${m}` }));
        return out;
      }),
    )
  ).flat();
  const elapsed = (performance.now() - t0) / 1000;
  const good = acks.filter((a) => a.ok);
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    sockets: { requested: SOCKETS, connected: ok.length, failed: conns.length - ok.length, connectMs: { p50: pct(ok.map((c) => c.ms), 50), p95: pct(ok.map((c) => c.ms), 95), p99: pct(ok.map((c) => c.ms), 99) } },
    joins: { ok: joins.filter((j) => j.ok).length, p95Ms: pct(joins.map((j) => j.ms), 95) },
    messages: {
      sent: acks.length,
      acked: good.length,
      rateLimited: acks.filter((a) => a.error?.code === 'RATE_LIMITED').length,
      timeouts: acks.filter((a) => a.timeout).length,
      throughputPerSec: Math.round(good.length / elapsed),
      ackMs: { p50: pct(good.map((a) => a.ms), 50), p95: pct(good.map((a) => a.ms), 95), p99: pct(good.map((a) => a.ms), 99) },
    },
  };
  ok.forEach((c) => c.s.close());
  const dir = path.resolve(__dirname, '../../loadtest-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sockets-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`saved ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
