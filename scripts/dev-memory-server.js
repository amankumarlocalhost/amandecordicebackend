'use strict';

/**
 * Zero-install local development: starts an in-memory MongoDB replica set (transactions work),
 * seeds the catalog with stock, creates a demo admin, and boots the API.
 * Data lives only while the process runs. Not for production.
 *
 *   npm run dev:memory
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('dev:memory is for local development only');
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replset.getUri('crockery');
  process.env.DEV_EXPOSE_OTP = process.env.DEV_EXPOSE_OTP || 'true';
  // Demo catalog images come from these hosts; real catalog images go through the media review queue.
  process.env.MEDIA_EXTERNAL_HOSTS = process.env.MEDIA_EXTERNAL_HOSTS || 'images.unsplash.com,picsum.photos';
  console.log(`in-memory MongoDB: ${process.env.MONGODB_URI}`);

  const { start } = require('../src/server');
  await start();

  const User = require('../src/modules/users/user.model');
  const { hashPassword } = require('../src/modules/auth/auth.service');
  const email = 'admin@crockery.local';
  if (!(await User.exists({ email }))) {
    await User.create({ name: 'Demo Admin', email, role: 'super_admin', passwordHash: await hashPassword('ChangeMe-Admin-123'), emailVerifiedAt: new Date() });
  }
  // Demo customer for local storefront testing (in-memory only; never runs in production).
  const customerEmail = 'aman@gmail.com';
  if (!(await User.exists({ email: customerEmail }))) {
    await User.create({ name: 'Aman Kumar', email: customerEmail, phone: '+919876543210', role: 'customer', passwordHash: await hashPassword('aman@1999'), phoneVerifiedAt: new Date() });
  }
  await require('./seed').runSeed({ withStock: true }); // re-uses the live connection
  console.log(`demo customer: ${customerEmail} / aman@1999`);
  console.log(`demo admin: ${email} / ChangeMe-Admin-123  ·  docs: http://localhost:${process.env.PORT || 4000}/api/docs`);

  const stop = async () => {
    await replset.stop();
  };
  process.on('exit', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
