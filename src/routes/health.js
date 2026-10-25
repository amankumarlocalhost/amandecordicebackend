'use strict';

const express = require('express');
const { monitorEventLoopDelay } = require('perf_hooks');
const { isDatabaseReady } = require('../config/database');
const { pingRedis } = require('../config/redis');
const { queueStats } = require('../queues');
const env = require('../config/env');

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let shuttingDown = false;
const setShuttingDown = () => {
  shuttingDown = true;
};

const router = express.Router();

router.get('/live', (req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()) }));

router.get('/ready', async (req, res) => {
  const checks = { mongo: isDatabaseReady() ? 'ok' : 'down' };
  try {
    const ms = await pingRedis();
    checks.redis = ms === null ? 'not_configured' : 'ok';
    checks.redisLatencyMs = ms ?? undefined;
  } catch {
    checks.redis = 'down';
  }
  const ready = !shuttingDown && checks.mongo === 'ok' && checks.redis !== 'down' && (!env.isProd || checks.redis === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', shuttingDown, checks });
});

/** Operational metrics (protect at the reverse proxy; no business data here). */
router.get('/metrics', async (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    queues: await queueStats().catch(() => ({ error: 'unavailable' })),
    uptime: Math.round(process.uptime()),
  });
  loop.reset();
});

module.exports = { router, setShuttingDown };
