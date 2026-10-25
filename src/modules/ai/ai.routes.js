'use strict';

const { z } = require('zod');
const customer = require('./customer.assistant');
const adminAssistant = require('./admin.assistant');
const { AIProposal, AIAdminSession } = require('./ai.models');
const { getGeminiClient } = require('../../config/gemini');
const { getSettings } = require('../settings/settings');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { limits } = require('../../middleware/rateLimit');
const { PERMISSIONS } = require('../../constants/roles');

const pid = z.object({ id: objectId() });

// ------------------------------------------------------------------ customer
const cust = createRouter({ prefix: '/api/v1/ai/customer', tag: 'AI: Customer' });

cust.get('/status', { summary: 'Whether the AI assistant is available (falls back to search/FAQ when not)' }, async (req, res) => {
  const s = await getSettings();
  ok(res, { enabled: Boolean(s.ai.customerEnabled && getGeminiClient()), fallbackAvailable: true });
});

cust.get('/proposals/:id', { summary: 'A pending action prepared by the assistant', customer: true, params: pid }, async (req, res) => {
  const p = await AIProposal.findOne({ _id: req.params.id, scope: 'customer', requestedFor: req.auth.userId }).select('tool title preview status expiresAt result').lean();
  if (!p) throw notFound('Proposal');
  ok(res, p);
});

cust.post('/proposals/:id/confirm', { summary: 'Confirm an assistant-prepared action (return, replacement, cancellation)', customer: true, rateLimit: limits.ai, params: pid }, async (req, res) => {
  ok(res, await customer.confirmProposal(req.auth, req.params.id));
});

cust.post('/proposals/:id/decline', { summary: 'Decline an assistant-prepared action', customer: true, params: pid }, async (req, res) => {
  ok(res, await customer.declineProposal(req.auth, req.params.id));
});

// ------------------------------------------------------------------ admin
const adm = createRouter({ prefix: '/api/v1/ai/admin', tag: 'AI: Admin' });

adm.post(
  '/chat',
  { summary: 'Ask the admin assistant (tools limited to your role)', permission: PERMISSIONS.AI_ADMIN, rateLimit: limits.ai, body: z.object({ sessionId: objectId().optional(), message: z.string().trim().min(2).max(2000) }) },
  async (req, res) => {
    ok(res, await adminAssistant.chat(req, req.body.sessionId, req.body.message));
  },
);

adm.get('/sessions', { summary: 'My assistant sessions', permission: PERMISSIONS.AI_ADMIN, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(AIAdminSession, { admin: req.auth.userId }, { ...req.query, sort: { updatedAt: -1 }, select: 'title updatedAt createdAt' });
  ok(res, items, { meta });
});

adm.get('/sessions/:id', { summary: 'Session history with tool summaries', permission: PERMISSIONS.AI_ADMIN, params: pid }, async (req, res) => {
  const s = await AIAdminSession.findOne({ _id: req.params.id, admin: req.auth.userId }).lean();
  if (!s) throw notFound('Session');
  ok(res, s);
});

adm.get(
  '/proposals',
  { summary: 'Proposed actions awaiting confirmation', permission: PERMISSIONS.AI_ADMIN, query: paginationSchema.extend({ status: z.enum(['pending', 'executed', 'declined', 'expired', 'failed']).default('pending') }) },
  async (req, res) => {
    const filter = { scope: 'admin', status: req.query.status };
    // Proposals are visible to their author and to anyone who holds the permission needed to confirm them.
    filter.$or = [{ requestedFor: req.auth.userId }, { requiredPermission: { $in: req.auth.permissions } }];
    const { items, meta } = await paginate(AIProposal, filter, { page: req.query.page, limit: req.query.limit });
    ok(res, items, { meta });
  },
);

adm.post('/proposals/:id/confirm', { summary: 'Confirm and execute a proposal (your permissions are re-checked)', permission: PERMISSIONS.AI_ADMIN, params: pid }, async (req, res) => {
  ok(res, await adminAssistant.confirm(req, req.params.id));
});

adm.post('/proposals/:id/decline', { summary: 'Decline a proposal', permission: PERMISSIONS.AI_ADMIN, params: pid }, async (req, res) => {
  ok(res, await adminAssistant.decline(req, req.params.id));
});

module.exports = { routers: [cust, adm] };
