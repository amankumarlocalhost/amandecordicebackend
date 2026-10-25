'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/** One record per Gemini request (no prompt or response text is stored). */
const usageSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['customer', 'admin', 'summary'], required: true },
    user: { type: ObjectId, ref: 'User' },
    conversation: ObjectId,
    model: String,
    status: { type: String, enum: ['ok', 'error', 'timeout', 'rate_limited', 'busy', 'disabled', 'quota_exceeded', 'fallback'], required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    durationMs: Number,
    toolCalls: [String],
    error: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
usageSchema.index({ createdAt: -1 });
usageSchema.index({ user: 1, createdAt: -1 });
usageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

/**
 * A consequential action prepared by the AI. It never executes on its own: a human with the right
 * authority confirms it, at which point the backend re-validates everything and executes it once.
 */
const proposalSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['customer', 'admin'], required: true },
    requestedFor: { type: ObjectId, ref: 'User', required: true }, // customer (customer scope) or admin who asked
    conversation: ObjectId,
    session: ObjectId,
    tool: { type: String, required: true },
    args: { type: mongoose.Schema.Types.Mixed, required: true },
    title: String,
    preview: mongoose.Schema.Types.Mixed,
    requiredPermission: String,
    status: { type: String, enum: ['pending', 'executing', 'executed', 'declined', 'expired', 'failed'], default: 'pending' },
    result: mongoose.Schema.Types.Mixed,
    error: String,
    executedBy: ObjectId,
    executedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
proposalSchema.index({ requestedFor: 1, status: 1, createdAt: -1 });
proposalSchema.index({ scope: 1, status: 1, createdAt: -1 });

const adminSessionSchema = new mongoose.Schema(
  {
    admin: { type: ObjectId, ref: 'User', required: true },
    title: { type: String, maxlength: 120 },
    messages: [
      new mongoose.Schema(
        { role: { type: String, enum: ['user', 'model'] }, text: String, toolTrace: [new mongoose.Schema({ name: String, ok: Boolean, ms: Number, error: String }, { _id: false })], proposals: [ObjectId], at: { type: Date, default: Date.now } },
        { _id: false },
      ),
    ],
  },
  { timestamps: true },
);
adminSessionSchema.index({ admin: 1, updatedAt: -1 });

module.exports = {
  AIUsageRecord: mongoose.model('AIUsageRecord', usageSchema),
  AIProposal: mongoose.model('AIProposal', proposalSchema),
  AIAdminSession: mongoose.model('AIAdminSession', adminSessionSchema),
};
