'use strict';

/**
 * Creates the first Super Admin (staff accounts can never be self-registered).
 *   npm run create-admin -- --email owner@store.in --name "Store Owner" --password 'Long-Random-Pass-1'
 * The password can also come from ADMIN_PASSWORD to keep it out of shell history.
 */
const { bootstrap, arg, done } = require('./lib');

async function main() {
  await bootstrap();
  const User = require('../src/modules/users/user.model');
  const { hashPassword } = require('../src/modules/auth/auth.service');
  const email = String(arg('email', '')).toLowerCase().trim();
  const name = String(arg('name', 'Super Admin'));
  const password = String(arg('password', process.env.ADMIN_PASSWORD || ''));
  const role = String(arg('role', 'super_admin'));
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('--email is required');
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('Password must be ≥ 12 chars with letters and digits');
  if (await User.exists({ email })) throw new Error('A user with this email already exists');
  const user = await User.create({ name, email, role, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
  console.log(`created ${role} ${email} (${user._id})`);
}

main()
  .then(() => done(0))
  .catch((err) => {
    console.error(err.message);
    done(1);
  });
