'use strict';

const { MongoMemoryReplSet } = require('mongodb-memory-server');

/** One in-memory single-node replica set for the whole run, so real transactions are exercised. */
module.exports = async () => {
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  global.__MONGO_REPLSET__ = replset;
  process.env.TEST_MONGO_URI = replset.getUri();
};
