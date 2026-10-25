'use strict';

const { Server } = require('socket.io');
const cookie = require('cookie');
const { z } = require('zod');
const env = require('../config/env');
const logger = require('../config/logger');
const { verifyAccessToken, loadAuthContext, ACCESS_COOKIE } = require('../middleware/auth');
const { permissionsFor, ROLES, PERMISSIONS } = require('../constants/roles');
const { attachServer, rooms } = require('./emitter');
const { toAppError } = require('../middleware/errorHandler');
const { objectId } = require('../utils/common');
const { forbidden } = require('../utils/errors');

const STAFF_ROOMS = [PERMISSIONS.SUPPORT_READ, PERMISSIONS.INVENTORY_WRITE, PERMISSIONS.RETURNS_WRITE, PERMISSIONS.ORDERS_WRITE, PERMISSIONS.CATALOG_READ, PERMISSIONS.MEDIA_REVIEW];

const schemas = {
  start: z.object({ channel: z.enum(['ai', 'human']).default('ai'), orderId: objectId().optional() }),
  join: z.object({ conversationId: objectId() }),
  message: z.object({ conversationId: objectId(), clientMessageId: z.string().regex(/^[\w-]{8,64}$/), body: z.string().max(2000).default(''), attachmentIds: z.array(objectId()).max(4).default([]) }),
  typing: z.object({ conversationId: objectId(), typing: z.boolean() }),
  handoff: z.object({ conversationId: objectId(), reason: z.string().max(300).optional() }),
  proposal: z.object({ proposalId: objectId() }),
};

/** Token bucket per socket: `capacity` events, refilled at `perSec`. */
function bucket(capacity, perSec) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

async function authenticateSocket(socket) {
  const origin = socket.handshake.headers.origin;
  if (origin && !env.frontendOrigins.includes(origin)) throw new Error('origin_not_allowed'); // cross-site WebSocket hijacking guard
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  const token = socket.handshake.auth?.token || cookies[ACCESS_COOKIE];
  if (!token) throw new Error('unauthorized');
  const payload = verifyAccessToken(token);
  const ctx = await loadAuthContext(payload.sub, payload.sid);
  if (!ctx) throw new Error('unauthorized');
  return { ...ctx, sessionId: payload.sid, isStaff: ctx.role !== ROLES.CUSTOMER, permissions: permissionsFor(ctx.role), tokenExp: payload.exp };
}

async function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.frontendOrigins, credentials: true },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25000,
    pingTimeout: 20000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
  });

  if (env.features.redis) {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createDuplicate } = require('../config/redis');
    io.adapter(createAdapter(createDuplicate(), createDuplicate()));
  }
  attachServer(io);

  // Public, receive-only namespace for storefront live updates (product/content publish events).
  // Anyone on an allowed origin may listen; no handler accepts client events, so visitors cannot
  // trigger anything here. Privileged actions only ever happen through authenticated REST calls.
  const { PUBLIC_NAMESPACE } = require('../services/sync');
  const pub = io.of(PUBLIC_NAMESPACE);
  pub.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin && !env.frontendOrigins.includes(origin)) return next(new Error('origin_not_allowed'));
    next();
  });
  pub.on('connection', (socket) => {
    socket.onAny(() => {}); // ignore everything clients send
  });
  const chat = require('../modules/chat/chat.service');
  const presence = require('./presence');

  io.use(async (socket, next) => {
    try {
      socket.data.auth = await authenticateSocket(socket);
      next();
    } catch (err) {
      next(new Error(err.message === 'origin_not_allowed' ? 'origin_not_allowed' : 'unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth;
    const allow = bucket(20, 2);
    const typingAllow = bucket(10, 2);
    const joined = new Set();
    socket.join(rooms.user(auth.userId));
    if (auth.isStaff) for (const p of STAFF_ROOMS) if (auth.permissions.includes(p)) socket.join(rooms.staff(p));
    presence.connected(auth.userId, auth.isStaff).then((online) => {
      if (auth.isStaff && online === 1) io.to(rooms.staff(PERMISSIONS.SUPPORT_READ)).emit('presence', { agentOnline: true });
    });

    // Sessions expire: disconnect when the access token does, so revocation takes effect for sockets too.
    const ttl = auth.tokenExp * 1000 - Date.now();
    const expiry = setTimeout(() => socket.emit('auth:expired') && socket.disconnect(true), Math.max(ttl, 1000));

    /** Wraps a handler with rate limiting, validation, and a uniform ack. */
    const on = (event, schema, handler, limiter = allow) => {
      socket.on(event, async (raw, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!limiter()) return reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } });
        try {
          const data = schema ? schema.parse(raw ?? {}) : raw;
          reply({ ok: true, data: await handler(data) });
        } catch (err) {
          const e = toAppError(err);
          if (!e) logger.error({ err: err.message, event }, 'socket handler failed');
          reply({ ok: false, error: { code: e?.code || 'INTERNAL_ERROR', message: e?.message || 'Something went wrong' } });
        }
      });
    };

    const joinConversation = async (conversationId) => {
      await chat.authorize(auth, conversationId);
      socket.join(rooms.conversation(conversationId));
      joined.add(String(conversationId));
    };

    on('chat:start', schemas.start, async ({ channel, orderId }) => {
      if (auth.isStaff) throw forbidden('Customers only');
      const conv = await chat.startConversation(auth.userId, { channel, orderId });
      await joinConversation(conv._id);
      return chat.history(auth, conv._id, {});
    });

    on('chat:join', schemas.join, async ({ conversationId }) => {
      await joinConversation(conversationId);
      return chat.history(auth, conversationId, {});
    });

    on('chat:leave', schemas.join, async ({ conversationId }) => {
      socket.leave(rooms.conversation(conversationId));
      joined.delete(String(conversationId));
      return null;
    });

    on('chat:message', schemas.message, async ({ conversationId, clientMessageId, body, attachmentIds }) => {
      const { message, duplicate } = await chat.postMessage(auth, conversationId, { clientMessageId, body, attachmentIds });
      if (!joined.has(String(conversationId))) await joinConversation(conversationId);
      return { message, duplicate };
    });

    on(
      'chat:typing',
      schemas.typing,
      async ({ conversationId, typing }) => {
        if (!joined.has(String(conversationId))) throw forbidden('Join the conversation first');
        socket.to(rooms.conversation(conversationId)).emit('chat:typing', { conversationId, from: auth.isStaff ? 'agent' : 'customer', typing });
        return null;
      },
      typingAllow,
    );

    on('chat:read', schemas.join, async ({ conversationId }) => {
      await chat.markRead(auth, conversationId);
      return null;
    });

    on('chat:handoff', schemas.handoff, async ({ conversationId, reason }) => {
      await chat.authorize(auth, conversationId);
      return chat.convDto(await chat.handoff(conversationId, { reason: reason || 'Customer asked for an agent' }));
    });

    on('chat:close', schemas.join, async ({ conversationId }) => chat.convDto(await chat.close(auth, conversationId)));

    on('ai:confirm', schemas.proposal, async ({ proposalId }) => {
      const assistant = require('../modules/ai/customer.assistant');
      return assistant.confirmProposal(auth, proposalId);
    });

    on('ai:decline', schemas.proposal, async ({ proposalId }) => {
      const assistant = require('../modules/ai/customer.assistant');
      return assistant.declineProposal(auth, proposalId);
    });

    socket.on('disconnect', () => {
      clearTimeout(expiry);
      presence.disconnected(auth.userId, auth.isStaff).then((online) => {
        if (auth.isStaff && online === 0) io.to(rooms.staff(PERMISSIONS.SUPPORT_READ)).emit('presence', { agentOnline: false });
      });
    });
  });

  logger.info({ redisAdapter: env.features.redis }, 'Socket.IO ready');
  return io;
}

module.exports = { initSockets, authenticateSocket };
