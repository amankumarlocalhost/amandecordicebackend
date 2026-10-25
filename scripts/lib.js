'use strict';

/** Shared bootstrap for CLI scripts: loads every module (so all models are registered) and connects. */
async function bootstrap() {
  const env = require('../src/config/env');
  const { connectDatabase } = require('../src/config/database');
  require('../src/routes').moduleRouters(); // registers all Mongoose models
  await connectDatabase();
  return env;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function done(code = 0) {
  const mongoose = require('mongoose');
  await mongoose.disconnect().catch(() => {});
  await require('../src/config/redis').closeRedis();
  process.exit(code);
}

module.exports = { bootstrap, arg, done };
