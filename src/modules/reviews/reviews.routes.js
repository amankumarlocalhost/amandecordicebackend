'use strict';

const { z } = require('zod');
const { Review, ReviewVote, ProductQuestion, clean, displayName, recomputeRating } = require('./reviews');
const Product = require('../products/product.model');
const Order = require('../orders/order.model');
const User = require('../users/user.model');
const media = require('../media/media');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, conflict, forbidden } = require('../../utils/errors');
const { objectId, paginationSchema, paginate, pageMeta } = require('../../utils/common');
const { limits } = require('../../middleware/rateLimit');
const { PERMISSIONS } = require('../../constants/roles');
const { ORDER_STATUS: S } = require('../../constants/statuses');

const PURCHASED = [S.DELIVERED, S.COMPLETED, S.RETURN_REQUESTED, S.REPLACEMENT_PROCESSING, S.RETURNED];
const pid = z.object({ id: objectId() });

const publicReview = (r) => ({ id: r._id, rating: r.rating, title: r.title, body: r.body, images: r.images?.map((x) => ({ kind: x.kind || 'image', url: x.url, thumbUrl: x.thumbUrl, posterUrl: x.posterUrl })), verifiedPurchase: r.verifiedPurchase, helpfulCount: r.helpfulCount, author: r.authorName, sku: r.sku, createdAt: r.createdAt });

const pub = createRouter({ prefix: '/api/v1', tag: 'Reviews & Q&A' });

pub.get(
  '/products/:id/reviews',
  { summary: 'Approved reviews for a product', params: pid, query: paginationSchema.extend({ sort: z.enum(['recent', 'helpful', 'rating_high', 'rating_low']).default('recent'), rating: z.coerce.number().int().min(1).max(5).optional(), withImages: z.enum(['true']).optional() }) },
  async (req, res) => {
    const { page, limit, sort, rating, withImages } = req.query;
    const filter = { product: req.params.id, status: 'approved' };
    if (rating) filter.rating = rating;
    if (withImages) filter['images.0'] = { $exists: true };
    const sorts = { recent: { createdAt: -1 }, helpful: { helpfulCount: -1, createdAt: -1 }, rating_high: { rating: -1, createdAt: -1 }, rating_low: { rating: 1, createdAt: -1 } };
    const { items, meta } = await paginate(Review, filter, { page, limit, sort: sorts[sort] });
    const product = await Product.findById(req.params.id).select('rating').lean();
    ok(res, items.map(publicReview), { meta: { ...meta, summary: product?.rating } });
  },
);

pub.post(
  '/products/:id/reviews',
  {
    summary: 'Write a review (one per product; purchase must be delivered). Published after moderation.',
    customer: true,
    rateLimit: limits.review,
    params: pid,
    body: z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), body: z.string().trim().min(10).max(4000).optional(), imageIds: z.array(objectId()).max(5).default([]) }),
  },
  async (req, res) => {
    const product = await Product.findById(req.params.id).select('_id').lean();
    if (!product) throw notFound('Product');
    const order = await Order.findOne({ user: req.auth.userId, 'items.product': product._id, status: { $in: PURCHASED } }).sort({ deliveredAt: -1 }).select('_id items.product items.sku').lean();
    if (!order) throw forbidden('You can review products you have received', 'PURCHASE_REQUIRED');
    const images = await media.resolveOwnedUploads(req.body.imageIds, req.auth.userId, 'review');
    const user = await User.findById(req.auth.userId).select('name').lean();
    try {
      const review = await Review.create({
        product: product._id,
        user: req.auth.userId,
        order: order._id,
        sku: order.items.find((i) => String(i.product) === String(product._id))?.sku,
        rating: req.body.rating,
        title: clean(req.body.title),
        body: clean(req.body.body),
        images: images.map(media.toRef),
        verifiedPurchase: true,
        authorName: displayName(user?.name),
      });
      created(res, publicReview(review), 'Thanks! Your review will appear after moderation.');
    } catch (err) {
      if (err.code === 11000) throw conflict('You have already reviewed this product. Edit your existing review instead.', 'ALREADY_REVIEWED');
      throw err;
    }
  },
);

pub.patch(
  '/reviews/:id',
  { summary: 'Edit my review (returns to moderation)', customer: true, params: pid, body: z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120), body: z.string().trim().min(10).max(4000) }).partial() },
  async (req, res) => {
    const set = { status: 'pending' };
    if (req.body.rating) set.rating = req.body.rating;
    if (req.body.title !== undefined) set.title = clean(req.body.title);
    if (req.body.body !== undefined) set.body = clean(req.body.body);
    const r = await Review.findOneAndUpdate({ _id: req.params.id, user: req.auth.userId }, { $set: set }, { new: true });
    if (!r) throw notFound('Review');
    await recomputeRating(r.product);
    ok(res, publicReview(r), { message: 'Review updated' });
  },
);

pub.delete('/reviews/:id', { summary: 'Delete my review', customer: true, params: pid }, async (req, res) => {
  const r = await Review.findOneAndDelete({ _id: req.params.id, user: req.auth.userId });
  if (!r) throw notFound('Review');
  await recomputeRating(r.product);
  ok(res, null, { message: 'Review deleted' });
});

pub.post('/reviews/:id/helpful', { summary: 'Mark a review helpful', customer: true, params: pid }, async (req, res) => {
  try {
    await ReviewVote.create({ review: req.params.id, user: req.auth.userId, kind: 'helpful' });
    await Review.updateOne({ _id: req.params.id }, { $inc: { helpfulCount: 1 } });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  ok(res, null, { message: 'Thanks for your feedback' });
});

pub.post('/reviews/:id/report', { summary: 'Report a review', customer: true, params: pid, body: z.object({ reason: z.enum(['spam', 'offensive', 'irrelevant', 'fake', 'personal_info', 'other']) }) }, async (req, res) => {
  try {
    await ReviewVote.create({ review: req.params.id, user: req.auth.userId, kind: 'report', reason: req.body.reason });
    const r = await Review.findByIdAndUpdate(req.params.id, { $inc: { reportCount: 1 } }, { new: true });
    if (r && r.reportCount >= 3 && r.status === 'approved') {
      await Review.updateOne({ _id: r._id }, { $set: { status: 'pending', moderationNote: 'Auto-hidden after 3 reports' } });
      await recomputeRating(r.product);
    }
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  ok(res, null, { message: 'Report received' });
});

pub.get('/products/:id/questions', { summary: 'Published questions & answers', params: pid, query: paginationSchema }, async (req, res) => {
  const filter = { product: req.params.id, status: 'published' };
  const [items, total] = await Promise.all([ProductQuestion.find(filter).sort({ createdAt: -1 }).skip((req.query.page - 1) * req.query.limit).limit(req.query.limit).lean(), ProductQuestion.countDocuments(filter)]);
  ok(res, items.map((q) => ({ id: q._id, question: q.question, author: q.authorName, answers: q.answers.map((a) => ({ text: a.text, author: a.staff ? 'Store team' : a.authorName, at: a.at })), createdAt: q.createdAt })), { meta: pageMeta(req.query.page, req.query.limit, total) });
});

pub.post('/products/:id/questions', { summary: 'Ask a question about a product', customer: true, rateLimit: limits.review, params: pid, body: z.object({ question: z.string().trim().min(10).max(500) }) }, async (req, res) => {
  if (!(await Product.exists({ _id: req.params.id }))) throw notFound('Product');
  const user = await User.findById(req.auth.userId).select('name').lean();
  const q = await ProductQuestion.create({ product: req.params.id, user: req.auth.userId, question: clean(req.body.question), authorName: displayName(user?.name) });
  created(res, { id: q._id }, 'Question submitted');
});

// ------------------------------------------------------------------ moderation
const admin = createRouter({ prefix: '/api/v1/admin', tag: 'Admin: Reviews' });

admin.get('/reviews', { summary: 'Moderation queue', permission: PERMISSIONS.REVIEWS_MODERATE, query: paginationSchema.extend({ status: z.enum(['pending', 'approved', 'rejected']).default('pending'), product: objectId().optional() }) }, async (req, res) => {
  const { page, limit, status, product } = req.query;
  const { items, meta } = await paginate(Review, { status, ...(product ? { product } : {}) }, { page, limit, sort: { reportCount: -1, createdAt: 1 }, populate: { path: 'product', select: 'name slug' } });
  ok(res, items, { meta });
});

admin.post(
  '/reviews/:id/moderate',
  { summary: 'Approve or reject a review', permission: PERMISSIONS.REVIEWS_MODERATE, params: pid, body: z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(300).optional() }) },
  async (req, res) => {
    const r = await Review.findByIdAndUpdate(req.params.id, { $set: { status: req.body.status, moderationNote: req.body.note } }, { new: true });
    if (!r) throw notFound('Review');
    await recomputeRating(r.product);
    await audit.record({ req, action: 'review.moderate', resource: { type: 'review', id: r._id }, metadata: req.body });
    ok(res, r, { message: 'Review moderated' });
  },
);

admin.get('/questions', { summary: 'Product questions', permission: PERMISSIONS.REVIEWS_MODERATE, query: paginationSchema.extend({ status: z.enum(['pending', 'published', 'rejected']).default('pending') }) }, async (req, res) => {
  const { items, meta } = await paginate(ProductQuestion, { status: req.query.status }, { page: req.query.page, limit: req.query.limit, sort: { createdAt: 1 }, populate: { path: 'product', select: 'name slug' } });
  ok(res, items, { meta });
});

admin.post(
  '/questions/:id/answer',
  { summary: 'Answer (and publish) or reject a question', permission: PERMISSIONS.REVIEWS_MODERATE, params: pid, body: z.object({ answer: z.string().trim().min(2).max(2000).optional(), status: z.enum(['published', 'rejected']).default('published') }) },
  async (req, res) => {
    const update = { $set: { status: req.body.status } };
    if (req.body.answer) update.$push = { answers: { by: req.auth.userId, staff: true, text: clean(req.body.answer) } };
    const q = await ProductQuestion.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!q) throw notFound('Question');
    ok(res, q, { message: 'Question updated' });
  },
);

module.exports = { routers: [pub, admin] };
