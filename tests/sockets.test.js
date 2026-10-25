'use strict';

const http = require('http');
const crypto = require('crypto');
const { io: ioc } = require('socket.io-client');
const { startApp, stopApp, Client, createStaff } = require('./helpers/app');
const { initSockets } = require('../src/sockets');
const { createFakeGemini } = require('./helpers/fakes');
const { setGeminiClient } = require('../src/config/gemini');
const { ChatMessage } = require('../src/modules/chat/chat.models');

let server;
let ioServer;
let url;
let gemini;
const sockets = [];

beforeAll(async () => {
  const { app } = await startApp();
  server = http.createServer(app);
  ioServer = await initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  gemini = createFakeGemini();
  setGeminiClient(gemini);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => ioServer.close(() => r()));
  await stopApp();
});

async function tokenFor(kind = 'customer') {
  if (kind !== 'customer') {
    const staff = await createStaff(kind);
    const res = await staff.agent.post('/api/v1/auth/admin/login').set('x-csrf-token', staff.csrf).set('x-client-type', 'mobile').send({ identifier: staff.user.email, password: 'Admin12345' });
    return { token: res.body.data.accessToken, user: res.body.data.user };
  }
  const c = new Client();
  const email = `s${crypto.randomBytes(4).toString('hex')}@example.com`;
  const phone = `9${String(crypto.randomInt(1e8, 1e9 - 1))}`;
  const res = await c.post('/api/v1/auth/register', { name: 'Socket User', email, phone, password: 'Secret123' }, { 'x-client-type': 'mobile' });
  return { token: res.body.data.accessToken, user: res.body.data.user };
}

function connect(token, opts = {}) {
  const s = ioc(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: opts.origin ? { origin: opts.origin } : {} });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}

const emit = (s, event, data) => new Promise((r) => s.emit(event, data, r));
const next = (s, event, filter = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event}`)), ms);
    const h = (d) => {
      if (!filter(d)) return;
      clearTimeout(t);
      s.off(event, h);
      resolve(d);
    };
    s.on(event, h);
  });

test('unauthenticated and foreign-origin connections are rejected', async () => {
  await expect(connect(null)).rejects.toThrow('unauthorized');
  await expect(connect('not-a-jwt')).rejects.toThrow('unauthorized');
  const { token } = await tokenFor();
  await expect(connect(token, { origin: 'https://evil.example' })).rejects.toThrow('origin_not_allowed');
});

test('customers cannot join or post into another customer\'s conversation', async () => {
  const a = await tokenFor();
  const b = await tokenFor();
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  const started = await emit(sa, 'chat:start', { channel: 'human' });
  expect(started.ok).toBe(true);
  const convId = started.data.conversation.id;
  const join = await emit(sb, 'chat:join', { conversationId: convId });
  expect(join).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  const post = await emit(sb, 'chat:message', { conversationId: convId, clientMessageId: crypto.randomUUID(), body: 'hijack' });
  expect(post.ok).toBe(false);
  const typing = await emit(sb, 'chat:typing', { conversationId: convId, typing: true });
  expect(typing.ok).toBe(false);
  const bad = await emit(sa, 'chat:message', { conversationId: 'not-an-id', clientMessageId: 'x', body: 'x' });
  expect(bad.error.code).toBe('VALIDATION_ERROR');
});

test('re-sent messages after reconnect are deduplicated and trigger one AI reply', async () => {
  gemini.script = [{ text: 'Hello! How can I help?' }];
  const a = await tokenFor();
  const s1 = await connect(a.token);
  const started = await emit(s1, 'chat:start', { channel: 'ai' });
  const convId = started.data.conversation.id;
  const clientMessageId = crypto.randomUUID();
  const reply = next(s1, 'chat:message', (m) => m.sender.type === 'ai');
  const first = await emit(s1, 'chat:message', { conversationId: convId, clientMessageId, body: 'hello' });
  expect(first.data.duplicate).toBe(false);
  await reply;
  s1.close();

  const s2 = await connect(a.token);
  const rejoin = await emit(s2, 'chat:join', { conversationId: convId });
  expect(rejoin.data.messages.map((m) => m.body)).toEqual(['hello', 'Hello! How can I help?']);
  const resend = await emit(s2, 'chat:message', { conversationId: convId, clientMessageId, body: 'hello' });
  expect(resend.data.duplicate).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(await ChatMessage.countDocuments({ conversation: convId, 'sender.type': 'customer' })).toBe(1);
  expect(await ChatMessage.countDocuments({ conversation: convId, 'sender.type': 'ai' })).toBe(1);
  expect(gemini.requests).toHaveLength(1);
});

test('human handoff, agent reply, typing indicator and real-time notification', async () => {
  const cust = await tokenFor();
  const agent = await tokenFor('support_agent');
  const sc = await connect(cust.token);
  const sa = await connect(agent.token);
  const queued = next(sa, 'support:conversation');
  const started = await emit(sc, 'chat:start', { channel: 'ai' });
  const convId = started.data.conversation.id;
  const handoff = await emit(sc, 'chat:handoff', { conversationId: convId, reason: 'Need a person' });
  expect(handoff.data.status).toBe('waiting_agent');
  await queued;

  expect((await emit(sa, 'chat:join', { conversationId: convId })).ok).toBe(true);
  const typing = next(sa, 'chat:typing');
  await emit(sc, 'chat:typing', { conversationId: convId, typing: true });
  expect(await typing).toMatchObject({ from: 'customer', typing: true });

  const msg = next(sc, 'chat:message', (m) => m.sender.type === 'agent');
  const notif = next(sc, 'notification:new', (n) => n.type === 'support_reply');
  const sent = await emit(sa, 'chat:message', { conversationId: convId, clientMessageId: crypto.randomUUID(), body: 'Hi, I am Priya from support.' });
  expect(sent.ok).toBe(true);
  expect((await msg).body).toBe('Hi, I am Priya from support.');
  expect((await notif).title).toMatch(/support/i);
  const read = next(sa, 'chat:read');
  await emit(sc, 'chat:read', { conversationId: convId });
  expect((await read).by).toBe('customer');
});

test('abusive clients are rate limited', async () => {
  const a = await tokenFor();
  const s = await connect(a.token);
  const started = await emit(s, 'chat:start', { channel: 'human' });
  const convId = started.data.conversation.id;
  const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => emit(s, 'chat:message', { conversationId: convId, clientMessageId: `spam-${i}-${crypto.randomUUID()}`, body: `spam ${i}` })));
  expect(acks.filter((x) => x.error?.code === 'RATE_LIMITED').length).toBeGreaterThan(10);
});

test('oversized payloads are rejected', async () => {
  const a = await tokenFor();
  const s = await connect(a.token);
  const started = await emit(s, 'chat:start', { channel: 'human' });
  const res = await emit(s, 'chat:message', { conversationId: started.data.conversation.id, clientMessageId: crypto.randomUUID(), body: 'x'.repeat(5000) });
  expect(res.ok).toBe(false);
});
