'use strict';

const mongoose = require('mongoose');
const { z } = require('zod');
const logger = require('../../config/logger');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { paginationSchema, paginate, dateFilter, objectId } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');

const auditSchema = new mongoose.Schema(
  {
    actor: {
      type: { type: String, enum: ['customer', 'staff', 'system', 'ai'], required: true },
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      role: String,
      onBehalfOf: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // AI acting for a user
    },
    action: { type: String, required: true },
    resource: { type: { type: String }, id: String },
    metadata: mongoose.Schema.Types.Mixed,
    ip: String,
    requestId: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ 'resource.type': 1, 'resource.id': 1, createdAt: -1 });
auditSchema.index({ 'actor.id': 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditSchema);

const SENSITIVE = /pass|otp|token|secret|signature|cvv|card|vpa|account_?number|ifsc/i;
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function actorFromReq(req, extra = {}) {
  if (!req?.auth) return { type: 'system', ...extra };
  return { type: req.auth.isStaff ? 'staff' : 'customer', id: req.auth.userId, role: req.auth.role, ...extra };
}

/** Writes an audit record. Never throws into the business flow. */
async function record({ actor, action, resource, metadata, req, session }) {
  try {
    const doc = {
      actor: actor || actorFromReq(req),
      action,
      resource: resource ? { type: resource.type, id: String(resource.id) } : undefined,
      metadata: metadata ? redact(metadata) : undefined,
      ip: req?.ip,
      requestId: req?.id,
    };
    await AuditLog.create([doc], session ? { session } : {});
  } catch (err) {
    logger.error({ err: err.message, action }, 'audit write failed');
  }
}

const api = createRouter({ prefix: '/api/v1/admin/audit-logs', tag: 'Admin: Audit' });
api.get(
  '/',
  {
    summary: 'List audit logs',
    permission: PERMISSIONS.AUDIT_READ,
    query: paginationSchema.extend({
      action: z.string().max(80).optional(),
      resourceType: z.string().max(40).optional(),
      resourceId: z.string().max(40).optional(),
      actorId: objectId().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  },
  async (req, res) => {
    const { page, limit, action, resourceType, resourceId, actorId, from, to } = req.query;
    const filter = {};
    if (action) filter.action = action;
    if (resourceType) filter['resource.type'] = resourceType;
    if (resourceId) filter['resource.id'] = resourceId;
    if (actorId) filter['actor.id'] = actorId;
    const created = dateFilter(from, to);
    if (created) filter.createdAt = created;
    const { items, meta } = await paginate(AuditLog, filter, { page, limit });
    ok(res, items, { meta });
  },
);

module.exports = { AuditLog, record, actorFromReq, redact, router: api };
