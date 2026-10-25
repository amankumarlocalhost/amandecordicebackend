'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectDatabase } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { registerJobs } = require('../../src/jobs');
const { registerListeners } = require('../../src/events/listeners');
const queues = require('../../src/queues');
const bus = require('../../src/events/bus');
const cache = require('../../src/services/cache');
const gateway = require('../../src/modules/payments/razorpay.gateway');
const { setGeminiClient } = require('../../src/config/gemini');
const { createFakeRazorpay } = require('./fakes');

let app;

async function startApp() {
  const dbName = `test_${crypto.randomBytes(5).toString('hex')}`;
  const uri = process.env.TEST_MONGO_URI.replace('/?', `/${dbName}?`);
  await connectDatabase(uri);
  registerListeners();
  registerJobs();
  app = createApp(); // requires every module, so all models are registered before indexes are built
  for (const m of Object.values(mongoose.models)) await m.createIndexes();
  const razorpay = createFakeRazorpay();
  gateway.setClient(razorpay);
  setGeminiClient(null);
  return { app, razorpay };
}

async function stopApp() {
  await settle();
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  cache.clearMemory();
}

/** Waits until queued jobs and event listeners have finished (inline queue mode). */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await bus.flush();
    await queues.drain();
  }
}

/** Supertest agent that tracks cookies and the double-submit CSRF token automatically. */
class Client {
  constructor(theApp = app) {
    this.agent = request.agent(theApp);
    this.csrf = null;
  }
  track(res) {
    for (const c of [].concat(res.headers['set-cookie'] || [])) {
      const m = /^csrf_token=([^;]*)/.exec(c);
      if (m && m[1]) this.csrf = decodeURIComponent(m[1]);
    }
    return res;
  }
  async ensureCsrf() {
    if (!this.csrf) this.track(await this.agent.get('/api/v1/auth/csrf'));
  }
  async get(url, query) {
    return this.track(await this.agent.get(url).query(query || {}));
  }
  async send(method, url, body, headers = {}) {
    await this.ensureCsrf();
    let req = this.agent[method](url).set('x-csrf-token', this.csrf);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return this.track(await req.send(body));
  }
  post(url, body, headers) {
    return this.send('post', url, body, headers);
  }
  patch(url, body, headers) {
    return this.send('patch', url, body, headers);
  }
  put(url, body, headers) {
    return this.send('put', url, body, headers);
  }
  delete(url, body, headers) {
    return this.send('delete', url, body, headers);
  }
}

let seq = 0;
function uniquePhone() {
  seq++;
  return `9${String(Date.now() % 1e8).padStart(8, '0')}${seq % 10}`.slice(0, 10);
}

async function registerCustomer({ name = 'Asha Verma', verifyPhone = true } = {}) {
  const c = new Client();
  const email = `cust${Date.now()}${++seq}@example.com`;
  const phone = uniquePhone();
  const res = await c.post('/api/v1/auth/register', { name, email, phone, password: 'Secret123' });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  c.user = res.body.data.user;
  if (verifyPhone) {
    const v = await c.post('/api/v1/auth/otp/verify-phone', { code: res.body.data.devCode });
    if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  }
  c.email = email;
  c.phone = c.user.phone;
  return c;
}

async function createStaff(role = 'super_admin') {
  const User = require('../../src/modules/users/user.model');
  const { hashPassword } = require('../../src/modules/auth/auth.service');
  const email = `${role}${Date.now()}${++seq}@store.test`;
  await User.create({ name: `${role} user`, email, role, passwordHash: await hashPassword('Admin12345'), emailVerifiedAt: new Date() });
  const c = new Client();
  const res = await c.post('/api/v1/auth/admin/login', { identifier: email, password: 'Admin12345' });
  if (res.status !== 200) throw new Error(`staff login failed ${JSON.stringify(res.body)}`);
  c.user = res.body.data.user;
  return c;
}

module.exports = { startApp, stopApp, settle, Client, registerCustomer, createStaff, getApp: () => app };
