'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

// NoSQL-injection protection is done at the edge (sanitize middleware + Zod schemas that
// only accept primitive types), so internal queries can use operators freely.
mongoose.set('strictQuery', true);

let transactionsSupported = false;

async function connectDatabase(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    autoIndex: env.MONGODB_AUTO_INDEX,
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  if (!transactionsSupported) {
    logger.warn('MongoDB is not a replica set: multi-document transactions are disabled. Use a replica set in production.');
  }
  logger.info({ transactionsSupported }, 'MongoDB connected');
  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

/**
 * Runs fn inside a transaction when the deployment supports it.
 * fn receives a session (or null) and must pass it to every query.
 */
const MAX_TX_ATTEMPTS = 12;
const isTransient = (err) => err?.hasErrorLabel?.('TransientTransactionError') || err?.code === 112; // WriteConflict
const isUnknownCommit = (err) => err?.hasErrorLabel?.('UnknownTransactionCommitResult');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn in a transaction when supported. Write conflicts on hot documents (popular SKUs during a
 * sale) are retried with jittered exponential backoff instead of the driver's immediate retry loop,
 * which avoids a thundering herd. fn must be idempotent with respect to its own side effects.
 */
async function withTransaction(fn) {
  if (!transactionsSupported) return fn(null);
  const session = await mongoose.startSession();
  try {
    for (let attempt = 1; ; attempt++) {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      let result;
      try {
        result = await fn(session);
      } catch (err) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});
        if (isTransient(err) && attempt < MAX_TX_ATTEMPTS) {
          await sleep(Math.random() * Math.min(500, 5 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      for (let c = 0; ; c++) {
        try {
          await session.commitTransaction();
          return result;
        } catch (err) {
          if (isUnknownCommit(err) && c < 3) continue;
          if (isTransient(err) && attempt < MAX_TX_ATTEMPTS) break;
          throw err;
        }
      }
      await sleep(Math.random() * Math.min(500, 5 * 2 ** attempt));
    }
  } finally {
    await session.endSession();
  }
}

/**
 * Like withTransaction, but hands fn a context `{ session, after }`. Callbacks pushed to `after`
 * (event publishing, job enqueueing) run only once the transaction has committed, and the list is
 * reset when the driver retries the transaction.
 */
async function transaction(fn) {
  let after = [];
  const result = await withTransaction(async (session) => {
    after = [];
    return fn({ session, after });
  });
  for (const cb of after) {
    try {
      await cb();
    } catch (err) {
      logger.error({ err: err.message }, 'post-commit callback failed');
    }
  }
  return result;
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  withTransaction,
  transaction,
  isDatabaseReady,
  supportsTransactions: () => transactionsSupported,
};
