'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const { createBullConnection } = require('../config/redis');

/**
 * Queue facade over BullMQ.
 *
 * - With REDIS_URL: durable BullMQ queues/workers, repeatable schedulers, failed jobs kept for review.
 * - Without Redis (development/test only — production refuses to boot without Redis):
 *   jobs run in-process with the same retry semantics, and schedulers use timers.
 *
 * Every processor must be idempotent: jobs can be retried or delivered more than once.
 */

const QUEUES = Object.freeze({
  NOTIFICATIONS: 'notifications',
  PAYMENTS: 'payments',
  INVENTORY: 'inventory',
  CAMPAIGNS: 'campaigns',
  MAINTENANCE: 'maintenance',
});

const processors = new Map(); // `${queue}:${name}` -> fn
const bullQueues = new Map();
const workers = [];
const timers = [];
const inflight = new Set();
const recentJobIds = new Map();
const inlineFailed = [];

const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: false,
};

function register(queue, name, fn) {
  processors.set(`${queue}:${name}`, fn);
}

function getBullQueue(name) {
  if (!bullQueues.has(name)) {
    const { Queue } = require('bullmq');
    bullQueues.set(name, new Queue(name, { connection: createBullConnection(), defaultJobOptions: DEFAULT_JOB_OPTS }));
  }
  return bullQueues.get(name);
}

async function runInline(queue, name, data, opts) {
  const fn = processors.get(`${queue}:${name}`);
  if (!fn) {
    logger.error({ queue, name }, 'No processor registered');
    return;
  }
  const attempts = opts.attempts ?? (env.isTest ? 1 : DEFAULT_JOB_OPTS.attempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fn(data, { id: opts.jobId, attemptsMade: attempt - 1, name });
      return;
    } catch (err) {
      logger.warn({ queue, name, attempt, err: err.message }, 'inline job failed');
      if (attempt === attempts) {
        inlineFailed.push({ queue, name, data, error: err.message, failedAt: new Date() });
        if (inlineFailed.length > 200) inlineFailed.shift();
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (attempt - 1), 30000)).unref?.());
    }
  }
}

/**
 * @param {string} queue
 * @param {string} name
 * @param {object} data
 * @param {{jobId?: string, delay?: number, attempts?: number}} opts jobId makes the enqueue idempotent.
 */
async function enqueue(queue, name, data, opts = {}) {
  if (env.features.redis) {
    const q = getBullQueue(queue);
    return q.add(name, data, { ...opts, jobId: opts.jobId ? opts.jobId.replace(/:/g, '_') : undefined });
  }
  if (opts.jobId) {
    const seen = recentJobIds.get(opts.jobId);
    if (seen && Date.now() - seen < 24 * 3600 * 1000) return null;
    recentJobIds.set(opts.jobId, Date.now());
    if (recentJobIds.size > 10000) recentJobIds.delete(recentJobIds.keys().next().value);
  }
  const p = new Promise((resolve) => {
    const t = setTimeout(() => runInline(queue, name, data, opts).finally(resolve), opts.delay || 0);
    t.unref?.();
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return null;
}

/** Waits for in-process jobs (tests / graceful shutdown in no-Redis mode). */
async function drain() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Repeatable job. */
async function schedule(queue, name, everyMs, data = {}) {
  if (env.features.redis) {
    const q = getBullQueue(queue);
    await q.upsertJobScheduler(`${queue}-${name}`, { every: everyMs }, { name, data, opts: { attempts: 3 } });
    return;
  }
  const t = setInterval(() => enqueue(queue, name, data, { attempts: 1 }), everyMs);
  t.unref?.();
  timers.push(t);
}

function startWorkers({ concurrency = 5 } = {}) {
  if (!env.features.redis) return;
  const { Worker } = require('bullmq');
  for (const queue of Object.values(QUEUES)) {
    const worker = new Worker(
      queue,
      async (job) => {
        const fn = processors.get(`${queue}:${job.name}`);
        if (!fn) throw new Error(`No processor for ${queue}:${job.name}`);
        return fn(job.data, job);
      },
      { connection: createBullConnection(), concurrency },
    );
    worker.on('failed', (job, err) =>
      logger.error({ queue, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
    );
    workers.push(worker);
  }
  logger.info({ queues: Object.values(QUEUES) }, 'BullMQ workers started');
}

async function failedJobs(limit = 50) {
  if (!env.features.redis) return inlineFailed.slice(-limit).reverse();
  const out = [];
  for (const queue of Object.values(QUEUES)) {
    const jobs = await getBullQueue(queue).getFailed(0, limit - 1);
    for (const j of jobs) {
      out.push({ queue, id: j.id, name: j.name, attemptsMade: j.attemptsMade, error: j.failedReason, failedAt: new Date(j.finishedOn || j.timestamp) });
    }
  }
  return out.sort((a, b) => b.failedAt - a.failedAt).slice(0, limit);
}

async function retryFailed(queue, id) {
  if (!env.features.redis) return false;
  const job = await getBullQueue(queue).getJob(id);
  if (!job) return false;
  await job.retry();
  return true;
}

async function queueStats() {
  if (!env.features.redis) return { mode: 'inline', inflight: inflight.size, failed: inlineFailed.length };
  const stats = {};
  for (const queue of Object.values(QUEUES)) stats[queue] = await getBullQueue(queue).getJobCounts('waiting', 'active', 'delayed', 'failed');
  return { mode: 'bullmq', queues: stats };
}

async function closeQueues() {
  timers.forEach(clearInterval);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([...bullQueues.values()].map((q) => q.close()));
  await drain();
}

module.exports = { QUEUES, register, enqueue, schedule, startWorkers, drain, failedJobs, retryFailed, queueStats, closeQueues };
