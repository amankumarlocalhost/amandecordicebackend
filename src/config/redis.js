'use strict';

const env = require('./env');
const logger = require('./logger');

let client = null;

function getRedis() {
  if (!env.REDIS_URL) return null;
  if (!client) {
    const Redis = require('ioredis');
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false });
    client.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  }
  return client;
}

/** BullMQ needs its own connections with maxRetriesPerRequest=null. */
function createBullConnection() {
  const Redis = require('ioredis');
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

function createDuplicate() {
  const Redis = require('ioredis');
  return new Redis(env.REDIS_URL);
}

async function pingRedis() {
  const r = getRedis();
  if (!r) return null;
  const started = Date.now();
  await r.ping();
  return Date.now() - started;
}

async function closeRedis() {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}

module.exports = { getRedis, createBullConnection, createDuplicate, pingRedis, closeRedis };
