'use strict';

const { z } = require('zod');
const env = require('../../config/env');
const channels = require('../../services/channels');
const queues = require('../../queues');
const audit = require('../audit/audit');
const { supportsTransactions } = require('../../config/database');
const { getGeminiClient } = require('../../config/gemini');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { PERMISSIONS } = require('../../constants/roles');

const api = createRouter({ prefix: '/api/v1/admin/system', tag: 'Admin: System' });

api.get('/status', { summary: 'Which integrations are configured (no secrets are returned)', permission: [PERMISSIONS.SETTINGS_WRITE, PERMISSIONS.JOBS_MANAGE] }, async (req, res) => {
  const c = channels.configured();
  ok(res, {
    environment: env.NODE_ENV,
    mongodbTransactions: supportsTransactions(),
    redis: env.features.redis,
    queueMode: env.features.redis ? 'bullmq' : 'inline (development only)',
    razorpay: { checkout: env.features.razorpay, webhooks: env.features.razorpayWebhooks },
    gemini: { configured: Boolean(getGeminiClient()), model: env.GEMINI_MODEL, adminModel: env.GEMINI_ADMIN_MODEL || env.GEMINI_MODEL },
    storage: env.STORAGE_DRIVER,
    email: c.email,
    sms: c.sms ? env.SMS_PROVIDER : false,
    whatsapp: c.whatsapp ? env.WHATSAPP_PROVIDER : false,
    couriers: ['manual'],
  });
});

api.get('/jobs', { summary: 'Queue depths', permission: PERMISSIONS.JOBS_MANAGE }, async (req, res) => {
  ok(res, await queues.queueStats());
});

api.get('/jobs/failed', { summary: 'Failed background jobs for review', permission: PERMISSIONS.JOBS_MANAGE, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (req, res) => {
  ok(res, await queues.failedJobs(req.query.limit));
});

api.post('/jobs/:queue/:id/retry', { summary: 'Retry a failed job (processors are idempotent)', permission: PERMISSIONS.JOBS_MANAGE, params: z.object({ queue: z.enum(Object.values(queues.QUEUES)), id: z.string().max(100) }) }, async (req, res) => {
  const retried = await queues.retryFailed(req.params.queue, req.params.id);
  if (!retried) throw notFound('Failed job');
  await audit.record({ req, action: 'jobs.retry', resource: { type: 'job', id: `${req.params.queue}:${req.params.id}` } });
  ok(res, null, { message: 'Job re-queued' });
});

api.get(
  '/errors',
  { summary: 'Recent unexpected (5xx) API errors, newest first', permission: [PERMISSIONS.JOBS_MANAGE, PERMISSIONS.SETTINGS_WRITE], query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), code: z.string().max(60).optional() }) },
  async (req, res) => {
    const { ErrorLog } = require('./error-log');
    const filter = req.query.code ? { code: req.query.code } : {};
    ok(res, await ErrorLog.find(filter).sort({ $natural: -1 }).limit(req.query.limit).lean());
  },
);

// ------------------------------------------------------------------ overview: work queues the signed-in staff member can act on
const overview = createRouter({ prefix: '/api/v1/admin/overview', tag: 'Admin: System' });

overview.get('/', { summary: 'Counts for the admin dashboard, limited to what your role may see', staff: true }, async (req, res) => {
  const has = (p) => req.auth.permissions.includes(p);
  const P = PERMISSIONS;
  const tasks = {};
  const jobs = [];
  if (has(P.CATALOG_READ)) {
    const Product = require('../products/product.model');
    jobs.push(
      Product.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).then((rows) => {
        tasks.products = Object.fromEntries(rows.map((r) => [r._id, r.n]));
      }),
      Product.countDocuments({ $or: [{ 'images.pending': true }, { 'images.replacement.ready': true }] }).then((n) => (tasks.productsWithPendingMedia = n)),
    );
  }
  if (has(P.MEDIA_REVIEW) || has(P.CATALOG_READ)) {
    const { Upload } = require('../media/media.model');
    jobs.push(Upload.countDocuments({ 'review.status': 'pending_review' }).then((n) => (tasks.mediaPendingReview = n)));
  }
  if (has(P.REVIEWS_MODERATE)) {
    const { Review, ProductQuestion } = require('../reviews/reviews');
    jobs.push(Review.countDocuments({ status: 'pending' }).then((n) => (tasks.reviewsPending = n)), ProductQuestion.countDocuments({ status: 'pending' }).then((n) => (tasks.questionsPending = n)));
  }
  if (has(P.ORDERS_READ)) {
    const Order = require('../orders/order.model');
    jobs.push(
      Order.countDocuments({ status: { $in: ['confirmed', 'processing', 'packed'] } }).then((n) => (tasks.ordersToFulfil = n)),
      Order.countDocuments({ status: 'pending' }).then((n) => (tasks.ordersAwaitingPayment = n)),
    );
  }
  if (has(P.RETURNS_READ)) {
    const ReturnRequest = require('../returns/return.model');
    jobs.push(ReturnRequest.countDocuments({ status: { $in: ['requested', 'awaiting_review'] } }).then((n) => (tasks.returnsAwaitingReview = n)));
  }
  if (has(P.PAYMENTS_READ) || has(P.REFUNDS_REQUEST)) {
    const { Refund } = require('../payments/payment.models');
    jobs.push(Refund.countDocuments({ status: 'pending_approval' }).then((n) => (tasks.refundsPendingApproval = n)));
  }
  if (has(P.INVENTORY_READ)) {
    const { Inventory } = require('../inventory/inventory.models');
    const { getSettings } = require('../settings/settings');
    jobs.push(
      getSettings().then((s) =>
        Promise.all([
          Inventory.countDocuments({ $expr: { $lte: [{ $subtract: ['$onHand', '$reserved'] }, 0] } }),
          Inventory.countDocuments({ $expr: { $lte: [{ $subtract: ['$onHand', '$reserved'] }, { $ifNull: ['$lowStockThreshold', s.inventory.defaultLowStockThreshold] }] } }),
          Inventory.countDocuments({ quarantine: { $gt: 0 } }),
        ]).then(([out, low, q]) => Object.assign(tasks, { outOfStockSkus: out, lowStockSkus: low, quarantinedSkus: q })),
      ),
    );
  }
  if (has(P.CONTENT_WRITE)) {
    const { SiteContent, Page } = require('../content/content.models');
    jobs.push(
      SiteContent.find({ $expr: { $ne: ['$draftVersion', '$publishedVersion'] } }).select('key').lean().then((rows) => (tasks.contentWithUnpublishedChanges = rows.map((r) => r.key))),
      Page.countDocuments({ status: { $ne: 'published' } }).then((n) => (tasks.pagesNotPublished = n)),
    );
  }
  if (has(P.SUPPORT_READ)) {
    const { Conversation } = require('../chat/chat.models');
    jobs.push(Conversation.countDocuments({ status: 'waiting_agent' }).then((n) => (tasks.conversationsWaiting = n)));
  }
  await Promise.all(jobs);
  ok(res, tasks);
});

module.exports = { routers: [api, overview] };
