'use strict';

const { getRedis } = require('../config/redis');
const logger = require('../config/logger');

/**
 * Small cache facade: Redis when configured, otherwise a bounded in-process map (dev/test only).
 * Namespaces are versioned, so `bump(ns)` invalidates every key in a namespace in O(1).
 * Only public, non-personal data is cached under shared keys.
 */

const MAX_MEMORY_KEYS = 5000;
const memory = new Map();
const memoryVersions = new Map();

function memGet(key) {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.exp && hit.exp < Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return hit.value === undefined ? undefined : JSON.parse(hit.value);
}

function memSet(key, value, ttlSec) {
  if (memory.size >= MAX_MEMORY_KEYS) memory.delete(memory.keys().next().value);
  memory.set(key, { value: value === undefined ? undefined : JSON.stringify(value), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

async function get(key) {
  const r = getRedis();
  if (!r) return memGet(key);
  try {
    const raw = await r.get(`c:${key}`);
    return raw === null ? undefined : JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: err.message }, 'cache get failed');
    return undefined;
  }
}

async function set(key, value, ttlSec = 60) {
  const r = getRedis();
  if (!r) return memSet(key, value, ttlSec);
  try {
    await r.set(`c:${key}`, JSON.stringify(value), 'EX', ttlSec);
  } catch (err) {
    logger.warn({ err: err.message }, 'cache set failed');
  }
}

async function del(key) {
  const r = getRedis();
  if (!r) return memory.delete(key);
  await r.del(`c:${key}`).catch(() => {});
}

async function version(ns) {
  const r = getRedis();
  if (!r) return memoryVersions.get(ns) || 0;
  try {
    return Number((await r.get(`cv:${ns}`)) || 0);
  } catch {
    return 0;
  }
}

async function bump(...namespaces) {
  const r = getRedis();
  for (const ns of namespaces) {
    if (!r) memoryVersions.set(ns, (memoryVersions.get(ns) || 0) + 1);
    else await r.incr(`cv:${ns}`).catch(() => {});
  }
}

/** Cache-aside helper for a namespaced key. */
async function wrap(ns, key, ttlSec, fn) {
  const v = await version(ns);
  const full = `${ns}:${v}:${key}`;
  const hit = await get(full);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value !== undefined) await set(full, value, ttlSec);
  return value;
}

/** Fixed-window counter used for quotas (e.g. daily AI usage). */
async function incrCounter(key, ttlSec) {
  const r = getRedis();
  if (!r) {
    const cur = memGet(`n:${key}`) || 0;
    memSet(`n:${key}`, cur + 1, ttlSec);
    return cur + 1;
  }
  const res = await r.multi().incr(`n:${key}`).expire(`n:${key}`, ttlSec, 'NX').exec();
  return Number(res[0][1]);
}

async function getCounter(key) {
  const r = getRedis();
  if (!r) return memGet(`n:${key}`) || 0;
  return Number((await r.get(`n:${key}`)) || 0);
}

/** Distributed lock with automatic expiry (best-effort; correctness never depends on it alone). */
async function acquireLock(key, ttlSec = 30) {
  const r = getRedis();
  if (!r) {
    if (memGet(`l:${key}`)) return false;
    memSet(`l:${key}`, 1, ttlSec);
    return true;
  }
  return (await r.set(`l:${key}`, '1', 'EX', ttlSec, 'NX')) === 'OK';
}

async function releaseLock(key) {
  const r = getRedis();
  if (!r) return memory.delete(`l:${key}`);
  await r.del(`l:${key}`).catch(() => {});
}

function clearMemory() {
  memory.clear();
  memoryVersions.clear();
}

const NS = Object.freeze({
  CATALOG: 'catalog',
  CATEGORIES: 'categories',
  PROMOTIONS: 'promotions',
  SETTINGS: 'settings',
  REPORTS: 'reports',
  CONTENT: 'content',
  AUTH: 'auth',
});

module.exports = { get, set, del, wrap, bump, version, incrCounter, getCounter, acquireLock, releaseLock, clearMemory, NS };
