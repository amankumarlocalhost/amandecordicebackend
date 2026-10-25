'use strict';

const { getRedis } = require('../config/redis');

/** Connection counts per user (multi-tab / multi-instance safe with Redis). */
const local = new Map();

async function change(userId, delta) {
  const r = getRedis();
  if (!r) {
    const n = Math.max(0, (local.get(userId) || 0) + delta);
    if (n) local.set(userId, n);
    else local.delete(userId);
    return n;
  }
  const n = await r.hincrby('presence', userId, delta);
  if (n <= 0) await r.hdel('presence', userId);
  return Math.max(0, n);
}

async function connected(userId, isStaff) {
  const n = await change(String(userId), 1);
  if (isStaff) await change('staff:agents', 1);
  return isStaff ? (await count('staff:agents')) : n;
}

async function disconnected(userId, isStaff) {
  const n = await change(String(userId), -1);
  if (isStaff) await change('staff:agents', -1);
  return isStaff ? (await count('staff:agents')) : n;
}

async function count(key) {
  const r = getRedis();
  if (!r) return local.get(key) || 0;
  return Number((await r.hget('presence', key)) || 0);
}

const isOnline = async (userId) => (await count(String(userId))) > 0;
const agentsOnline = () => count('staff:agents');

module.exports = { connected, disconnected, isOnline, agentsOnline };
