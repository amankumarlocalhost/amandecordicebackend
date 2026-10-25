'use strict';

const http = require('http');
const env = require('./config/env');
const logger = require('./config/logger');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { closeRedis } = require('./config/redis');
const { createApp } = require('./app');
const { initSockets } = require('./sockets');
const { registerJobs, registerSchedules } = require('./jobs');
const { registerListeners } = require('./events/listeners');
const { startWorkers, closeQueues } = require('./queues');
const { setShuttingDown } = require('./routes/health');

async function start() {
  await connectDatabase();
  registerListeners();
  registerJobs();
  if (env.RUN_WORKERS) startWorkers();
  if (env.RUN_SCHEDULERS) await registerSchedules();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000; // above typical load-balancer idle timeout
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;
  const io = await initSockets(server);

  await new Promise((resolve) => server.listen(env.PORT, resolve));
  logger.info({ port: env.PORT, env: env.NODE_ENV, features: env.features }, 'API listening');

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    setShuttingDown();
    const force = setTimeout(() => process.exit(1), 25000);
    force.unref();
    await new Promise((r) => io.close(() => r()));
    await new Promise((r) => server.close(() => r()));
    await closeQueues();
    await disconnectDatabase();
    await closeRedis();
    logger.info('shutdown complete');
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  return { app, server, io };
}

if (require.main === module) {
  start().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { start };
