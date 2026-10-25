'use strict';

/**
 * Standalone background worker (recommended in production so API latency is not affected by
 * jobs). Run API instances with RUN_WORKERS=false and RUN_SCHEDULERS=false, and one or more of
 * these processes with Redis configured.
 */
const env = require('./config/env');
const logger = require('./config/logger');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { closeRedis } = require('./config/redis');
const { registerJobs, registerSchedules } = require('./jobs');
const { registerListeners } = require('./events/listeners');
const { startWorkers, closeQueues } = require('./queues');

async function main() {
  if (!env.features.redis) throw new Error('The standalone worker requires REDIS_URL');
  await connectDatabase();
  registerListeners();
  registerJobs();
  startWorkers({ concurrency: Number(process.env.WORKER_CONCURRENCY || 10) });
  await registerSchedules();
  logger.info('worker started');
  const stop = async () => {
    await closeQueues();
    await disconnectDatabase();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'worker failed');
  process.exit(1);
});
