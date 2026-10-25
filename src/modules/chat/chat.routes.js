'use strict';

const { z } = require('zod');
const service = require('./chat.service');
const { Conversation, SupportTicket } = require('./chat.models');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, badRequest } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');

const cid = z.object({ id: objectId() });
const messageBody = z.object({ body: z.string().max(2000).default(''), attachmentIds: z.array(objectId()).max(4).default([]), clientMessageId: z.string().regex(/^[\w-]{8,64}$/).optional() });

// ------------------------------------------------------------------ customer chat (REST mirror of the socket API)
const chat = createRouter({ prefix: '/api/v1/chat', tag: 'Chat' });

chat.post('/conversations', { summary: 'Start (or resume) a support conversation', customer: true, body: z.object({ channel: z.enum(['ai', 'human']).default('ai'), orderId: objectId().optional(), subject: z.string().max(200).optional() }) }, async (req, res) => {
  const conv = await service.startConversation(req.auth.userId, req.body);
  created(res, service.convDto(conv));
});

chat.get('/conversations', { summary: 'My conversations', customer: true, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(Conversation, { customer: req.auth.userId }, { ...req.query, sort: { lastMessageAt: -1 } });
  ok(res, items.map(service.convDto), { meta });
});

chat.get('/conversations/:id/messages', { summary: 'Message history (cursor: before=ISO date)', auth: 'required', params: cid, query: z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }, async (req, res) => {
  ok(res, await service.history(req.auth, req.params.id, req.query));
});

chat.post('/conversations/:id/messages', { summary: 'Send a message (idempotent with clientMessageId)', auth: 'required', params: cid, body: messageBody }, async (req, res) => {
  const { message, duplicate } = await service.postMessage(req.auth, req.params.id, req.body);
  (duplicate ? ok : created)(res, message);
});

chat.post('/conversations/:id/read', { summary: 'Mark conversation read', auth: 'required', params: cid }, async (req, res) => {
  await service.markRead(req.auth, req.params.id);
  ok(res, null);
});

chat.post('/conversations/:id/handoff', { summary: 'Ask for a human agent', customer: true, params: cid, body: z.object({ reason: z.string().max(300).optional() }) }, async (req, res) => {
  await service.authorize(req.auth, req.params.id);
  ok(res, service.convDto(await service.handoff(req.params.id, { reason: req.body.reason || 'Customer asked for an agent' })));
});

chat.post('/conversations/:id/close', { summary: 'Close a conversation', auth: 'required', params: cid }, async (req, res) => {
  ok(res, service.convDto(await service.close(req.auth, req.params.id)));
});

// ------------------------------------------------------------------ tickets
const support = createRouter({ prefix: '/api/v1/support', tag: 'Support' });

support.post(
  '/tickets',
  { summary: 'Raise a support ticket', customer: true, body: z.object({ subject: z.string().trim().min(5).max(200), description: z.string().trim().min(10).max(4000), category: z.enum(['order', 'delivery', 'return', 'payment', 'product', 'account', 'other']).default('other'), orderId: objectId().optional() }) },
  async (req, res) => {
    const t = await service.createTicket(req.auth.userId, req.body);
    created(res, { id: t._id, ticketNumber: t.ticketNumber, status: t.status });
  },
);

support.get('/tickets', { summary: 'My tickets', customer: true, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(SupportTicket, { customer: req.auth.userId }, { ...req.query, select: 'ticketNumber subject category status priority order createdAt resolvedAt' });
  ok(res, items, { meta });
});

support.get('/tickets/:id', { summary: 'Ticket detail', customer: true, params: cid }, async (req, res) => {
  const t = await SupportTicket.findOne({ _id: req.params.id, customer: req.auth.userId }).select('-notes -assignedTo').lean();
  if (!t) throw notFound('Ticket');
  ok(res, t);
});

// ------------------------------------------------------------------ admin support desk
const admin = createRouter({ prefix: '/api/v1/admin/support', tag: 'Admin: Support' });

admin.get(
  '/conversations',
  { summary: 'Support inbox', permission: PERMISSIONS.SUPPORT_READ, query: paginationSchema.extend({ status: z.enum(['open', 'waiting_agent', 'assigned', 'closed']).optional(), channel: z.enum(['ai', 'human']).optional(), mine: z.enum(['true']).optional() }) },
  async (req, res) => {
    const { page, limit, status, channel, mine } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (channel) filter.channel = channel;
    if (mine) filter.assignedAgent = req.auth.userId;
    const { items, meta } = await paginate(Conversation, filter, { page, limit, sort: { lastMessageAt: -1 }, populate: { path: 'customer', select: 'name email phone' } });
    ok(res, items, { meta });
  },
);

admin.post('/conversations/:id/assign', { summary: 'Assign a conversation to me', permission: PERMISSIONS.SUPPORT_WRITE, params: cid }, async (req, res) => {
  const conv = await service.assign(req.params.id, req.auth.userId);
  await audit.record({ req, action: 'support.assign', resource: { type: 'conversation', id: conv._id } });
  ok(res, service.convDto(conv));
});

admin.post('/conversations/:id/messages', { summary: 'Agent reply', permission: PERMISSIONS.SUPPORT_WRITE, params: cid, body: messageBody }, async (req, res) => {
  const { message } = await service.postMessage(req.auth, req.params.id, req.body);
  created(res, message);
});

admin.get(
  '/tickets',
  { summary: 'Ticket queue', permission: PERMISSIONS.SUPPORT_READ, query: paginationSchema.extend({ status: z.enum(['open', 'in_progress', 'pending_customer', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }) },
  async (req, res) => {
    const { page, limit, status, priority } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    const { items, meta } = await paginate(SupportTicket, filter, { page, limit, sort: { createdAt: 1 }, populate: { path: 'customer', select: 'name email phone' } });
    ok(res, items, { meta });
  },
);

admin.patch(
  '/tickets/:id',
  { summary: 'Update ticket status/priority/assignee or add a note', permission: PERMISSIONS.SUPPORT_WRITE, params: cid, body: z.object({ status: z.enum(['open', 'in_progress', 'pending_customer', 'resolved', 'closed']), priority: z.enum(['low', 'normal', 'high', 'urgent']), assignedTo: objectId(), note: z.string().max(2000) }).partial() },
  async (req, res) => {
    const { note, ...set } = req.body;
    if (!Object.keys(req.body).length) throw badRequest('Nothing to update');
    if (set.status === 'resolved') set.resolvedAt = new Date();
    const update = { $set: set };
    if (note) update.$push = { notes: { by: req.auth.userId, note } };
    const t = await SupportTicket.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!t) throw notFound('Ticket');
    await audit.record({ req, action: 'support.ticket_update', resource: { type: 'ticket', id: t._id }, metadata: set });
    ok(res, t);
  },
);

module.exports = { routers: [chat, support, admin] };
