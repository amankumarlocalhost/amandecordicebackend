'use strict';

const mongoose = require('mongoose');

/**
 * Operational error visibility for the admin panel: unexpected (5xx) API errors are recorded in a
 * small capped collection (oldest entries roll off automatically). No request bodies, headers or
 * personal data are stored — only what an operator needs to correlate with the server logs.
 */
const errorLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    requestId: String,
    method: String,
    path: String,
    status: Number,
    code: String,
    message: { type: String, maxlength: 500 },
    userId: String,
  },
  { capped: { size: 5 * 1024 * 1024, max: 5000 }, versionKey: false },
);

const ErrorLog = mongoose.model('ErrorLog', errorLogSchema);

function recordError(req, status, err) {
  if (mongoose.connection.readyState !== 1) return;
  ErrorLog.create({
    requestId: req.id,
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300),
    status,
    code: err?.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
    message: String(err?.message || 'error').slice(0, 500),
    userId: req.auth?.userId,
  }).catch(() => {});
}

module.exports = { ErrorLog, recordError };
