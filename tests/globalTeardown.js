'use strict';

module.exports = async () => {
  if (global.__MONGO_REPLSET__) await global.__MONGO_REPLSET__.stop();
};
