'use strict';

/**
 * Builds every schema index (run on each deploy; production runs with MONGODB_AUTO_INDEX=false).
 *   npm run sync-indexes                  # create missing indexes only (safe)
 *   npm run sync-indexes -- --drop-extra  # also drop indexes not in the schemas (review first!)
 */
const mongoose = require('mongoose');
const { bootstrap, arg, done } = require('./lib');

async function main() {
  await bootstrap();
  const drop = Boolean(arg('drop-extra'));
  for (const model of Object.values(mongoose.models)) {
    if (drop) {
      const dropped = await model.syncIndexes();
      console.log(`${model.modelName}: synced${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
    } else {
      await model.createIndexes();
      console.log(`${model.modelName}: ok`);
    }
  }
}

main()
  .then(() => done(0))
  .catch((err) => {
    console.error(err.message);
    done(1);
  });
