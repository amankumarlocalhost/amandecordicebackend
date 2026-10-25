'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const reviewSchema = new mongoose.Schema(
  {
    product: { type: ObjectId, ref: 'Product', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    order: { type: ObjectId, ref: 'Order' },
    sku: String,
    rating: { type: Number, min: 1, max: 5, required: true },
    title: { type: String, maxlength: 120 },
    body: { type: String, maxlength: 4000 },
    images: [new mongoose.Schema({ upload: ObjectId, kind: { type: String, enum: ['image', 'video'], default: 'image' }, url: String, thumbUrl: String, posterUrl: String }, { _id: false })],
    verifiedPurchase: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    moderationNote: String,
    reportCount: { type: Number, default: 0 },
    helpfulCount: { type: Number, default: 0 },
    authorName: String, // display name captured at submission ("Priya S.")
  },
  { timestamps: true },
);
reviewSchema.index({ user: 1, product: 1 }, { unique: true }); // one review per customer per product
reviewSchema.index({ product: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, reportCount: -1, createdAt: 1 });

const voteSchema = new mongoose.Schema({ review: { type: ObjectId, required: true }, user: { type: ObjectId, required: true }, kind: { type: String, enum: ['helpful', 'report'], required: true }, reason: String }, { timestamps: true });
voteSchema.index({ review: 1, user: 1, kind: 1 }, { unique: true });

const questionSchema = new mongoose.Schema(
  {
    product: { type: ObjectId, ref: 'Product', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    question: { type: String, required: true, maxlength: 500 },
    answers: [new mongoose.Schema({ by: ObjectId, staff: Boolean, authorName: String, text: { type: String, maxlength: 2000 }, at: { type: Date, default: Date.now } }, { _id: true })],
    status: { type: String, enum: ['pending', 'published', 'rejected'], default: 'pending' },
    authorName: String,
  },
  { timestamps: true },
);
questionSchema.index({ product: 1, status: 1, createdAt: -1 });

const Review = mongoose.model('Review', reviewSchema);
const ReviewVote = mongoose.model('ReviewVote', voteSchema);
const ProductQuestion = mongoose.model('ProductQuestion', questionSchema);

/**
 * User-generated content is stored as plain text: tags and control characters are stripped
 * (clients must still escape on output — this is defence in depth, not an HTML sanitiser).
 */
const clean = (s) =>
  s
    ? String(s)
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
    : s;
const displayName = (name = '') => {
  const [first, last] = String(name).trim().split(/\s+/);
  return last ? `${first} ${last[0]}.` : first || 'Customer';
};

async function recomputeRating(productId) {
  const Product = require('../products/product.model');
  const rows = await Review.aggregate([{ $match: { product: new mongoose.Types.ObjectId(String(productId)), status: 'approved' } }, { $group: { _id: '$rating', n: { $sum: 1 } } }]);
  const distribution = [0, 0, 0, 0, 0];
  for (const r of rows) distribution[r._id - 1] = r.n;
  const count = distribution.reduce((a, b) => a + b, 0);
  const average = count ? Math.round((distribution.reduce((a, n, i) => a + n * (i + 1), 0) / count) * 10) / 10 : 0;
  await Product.updateOne({ _id: productId }, { $set: { rating: { average, count, distribution } } });
  const cache = require('../../services/cache');
  await cache.bump(cache.NS.CATALOG);
  const p = await Product.findById(productId).select('slug status').lean();
  if (p?.status === 'active') {
    const sync = require('../../services/sync');
    sync.changed({ tags: [sync.TAGS.CATALOG, sync.TAGS.product(p.slug)], events: [{ event: sync.EVENTS.PRODUCT_UPDATED, id: String(productId), slug: p.slug }] });
  }
}

module.exports = { Review, ReviewVote, ProductQuestion, clean, displayName, recomputeRating };
