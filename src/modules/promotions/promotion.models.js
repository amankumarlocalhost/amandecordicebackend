'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const scopeSchema = new mongoose.Schema(
  {
    appliesTo: { type: String, enum: ['all', 'products', 'categories', 'brands', 'collections'], default: 'all' },
    products: [{ type: ObjectId, ref: 'Product' }],
    categories: [{ type: ObjectId, ref: 'Category' }],
    brands: [{ type: String, lowercase: true, trim: true }],
    collections: [{ type: ObjectId, ref: 'Collection' }],
    excludeProducts: [{ type: ObjectId, ref: 'Product' }],
  },
  { _id: false },
);

const discountFields = {
  discountType: { type: String, enum: ['percentage', 'fixed', 'free_shipping'], required: true },
  /** percentage: basis points (1000 = 10%); fixed: paise; free_shipping: 0 */
  value: { type: Number, min: 0, default: 0, validate: Number.isInteger },
  maxDiscount: { type: Number, min: 0, validate: Number.isInteger },
  scope: { type: scopeSchema, default: () => ({}) },
  minCartValue: { type: Number, min: 0, default: 0 },
  segment: { type: String, enum: ['all', 'new_customers', 'repeat_customers'], default: 'all' },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  timezone: { type: String, default: 'Asia/Kolkata' },
  isActive: { type: Boolean, default: false },
  campaign: { type: ObjectId, ref: 'Campaign' },
  createdBy: { type: ObjectId, ref: 'User' },
};

/** A festival / seasonal sale grouping promotions and coupons under one schedule. */
const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true },
    festival: { type: String, trim: true, maxlength: 60 }, // e.g. diwali, wedding_season, new_year
    description: { type: String, maxlength: 2000 },
    banner: { media: { type: ObjectId, ref: 'Upload' }, url: String, mobileMedia: { type: ObjectId, ref: 'Upload' }, mobileUrl: String, alt: String },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    isActive: { type: Boolean, default: false },
    announcedAt: Date,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
campaignSchema.index({ slug: 1 }, { unique: true });
campaignSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

const promotionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 500 },
    ...discountFields,
    priority: { type: Number, default: 0 },
    stackableWithCoupons: { type: Boolean, default: true },
    badge: { type: String, maxlength: 30 },
  },
  { timestamps: true },
);
promotionSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9_-]{3,30}$/ },
    description: { type: String, maxlength: 500 },
    ...discountFields,
    usageLimit: { type: Number, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    perCustomerLimit: { type: Number, min: 1, default: 1 },
    firstOrderOnly: { type: Boolean, default: false },
    stackableWithPromotions: { type: Boolean, default: false },
    paymentMethods: [{ type: String, enum: ['upi', 'cod'] }],
    isPublic: { type: Boolean, default: false }, // shown in the "available offers" list
  },
  { timestamps: true },
);
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ isActive: 1, isPublic: 1, endsAt: 1 });

/** Per-customer counter enabling an atomic "count < limit" check via a unique (coupon,user) key. */
const couponUsageSchema = new mongoose.Schema({
  coupon: { type: ObjectId, ref: 'Coupon', required: true },
  user: { type: ObjectId, ref: 'User', required: true },
  count: { type: Number, default: 0 },
});
couponUsageSchema.index({ coupon: 1, user: 1 }, { unique: true });

const redemptionSchema = new mongoose.Schema(
  {
    coupon: { type: ObjectId, ref: 'Coupon', required: true },
    code: String,
    user: { type: ObjectId, ref: 'User', required: true },
    order: { type: ObjectId, ref: 'Order', required: true },
    discount: Number,
    status: { type: String, enum: ['redeemed', 'released'], default: 'redeemed' },
  },
  { timestamps: true },
);
redemptionSchema.index({ order: 1 }, { unique: true });
redemptionSchema.index({ coupon: 1, status: 1, createdAt: -1 });

module.exports = {
  Campaign: mongoose.model('Campaign', campaignSchema),
  Promotion: mongoose.model('Promotion', promotionSchema),
  Coupon: mongoose.model('Coupon', couponSchema),
  CouponUsage: mongoose.model('CouponUsage', couponUsageSchema),
  CouponRedemption: mongoose.model('CouponRedemption', redemptionSchema),
};
