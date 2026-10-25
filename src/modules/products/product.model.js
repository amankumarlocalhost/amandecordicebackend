'use strict';

const mongoose = require('mongoose');
const { seoSchema } = require('../categories/category.model');
const { PRODUCT_STATUS, MATERIALS, PACKAGING_REQUIREMENTS } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;
const money = { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'Money must be integer paise' } };

const dimensionsSchema = new mongoose.Schema(
  { lengthMm: { type: Number, min: 0 }, widthMm: { type: Number, min: 0 }, heightMm: { type: Number, min: 0 }, diameterMm: { type: Number, min: 0 } },
  { _id: false },
);

const variantSchema = new mongoose.Schema({
  sku: { type: String, required: true, uppercase: true, trim: true, maxlength: 64 },
  barcode: { type: String, trim: true, maxlength: 64 },
  title: { type: String, trim: true, maxlength: 120 },
  attributes: {
    color: { type: String, trim: true, lowercase: true, maxlength: 40 },
    pattern: { type: String, trim: true, lowercase: true, maxlength: 60 },
    capacityMl: { type: Number, min: 0 },
    setSize: { type: Number, min: 1 },
    size: { type: String, trim: true, maxlength: 40 },
  },
  mrp: { ...money, required: true },
  price: { ...money, required: true },
  costPrice: money,
  weightGrams: { type: Number, min: 0 },
  dimensions: dimensionsSchema,
  images: [{ type: String }],
  isDefault: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
});

const imageRefSchema = new mongoose.Schema(
  { media: { type: ObjectId, ref: 'Upload' }, url: String, thumbUrl: String, mediumUrl: String, ready: Boolean, at: Date, by: { type: ObjectId, ref: 'User' } },
  { _id: false },
);

/**
 * Gallery entry. `media` points at the reviewed Upload; URLs are copied from it only once approved.
 * pending = attached but not yet approved (never served publicly). replacement = a staged swap that
 * goes live only when explicitly published after approval; previous = the swapped-out asset (rollback).
 */
const imageSchema = new mongoose.Schema({
  media: { type: ObjectId, ref: 'Upload' },
  url: String,
  key: String,
  thumbUrl: String,
  mediumUrl: String,
  pending: { type: Boolean, default: false },
  alt: { type: String, maxlength: 160 },
  sortOrder: { type: Number, default: 0 },
  // Attribution for imported stock photography (e.g. Unsplash). Its presence also marks the image as
  // representative rather than a photograph of the exact item.
  credit: new mongoose.Schema({ provider: String, author: String, authorUrl: String, pageUrl: String }, { _id: false }),
  replacement: imageRefSchema,
  previous: imageRefSchema,
});

/** Safety attributes are tri-state: true/false only when verified, null when unknown (never displayed). */
const triState = { type: Boolean, default: null };

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: ['simple', 'bundle'], default: 'simple' },
    description: { type: String, maxlength: 10000 },
    highlights: [{ type: String, maxlength: 200 }],
    category: { type: ObjectId, ref: 'Category', required: true },
    categoryPath: [{ type: ObjectId, ref: 'Category' }],
    brand: { type: String, trim: true, maxlength: 80 },
    collections: [{ type: ObjectId, ref: 'Collection' }],
    tags: [{ type: String, lowercase: true, trim: true, maxlength: 40 }],
    images: [imageSchema],
    videos: [
      new mongoose.Schema({ media: { type: ObjectId, ref: 'Upload' }, url: { type: String, required: true }, key: String, posterUrl: String, thumbUrl: String, durationSec: Number, title: { type: String, maxlength: 120 }, sortOrder: { type: Number, default: 0 } }),
    ],
    variants: { type: [variantSchema], validate: [(v) => v.length > 0 && v.length <= 100, 'A product needs 1–100 variants'] },
    bundleItems: [
      new mongoose.Schema(
        { product: { type: ObjectId, ref: 'Product', required: true }, sku: { type: String, required: true, uppercase: true }, quantity: { type: Number, min: 1, required: true }, name: String },
        { _id: false },
      ),
    ],
    specs: {
      material: { type: String, enum: MATERIALS },
      materials: [{ type: String, enum: MATERIALS }],
      color: { type: String, lowercase: true, trim: true, maxlength: 40 },
      pattern: { type: String, lowercase: true, trim: true, maxlength: 60 },
      finish: { type: String, trim: true, maxlength: 60 },
      design: { type: String, trim: true, maxlength: 80 },
      capacityMl: { type: Number, min: 0 },
      dimensions: dimensionsSchema,
      weightGrams: { type: Number, min: 0 },
      piecesPerSet: { type: Number, min: 1 },
      serves: { type: Number, min: 1 },
      setComposition: [new mongoose.Schema({ item: { type: String, maxlength: 60 }, count: { type: Number, min: 1 } }, { _id: false })],
    },
    care: {
      foodSafe: triState,
      dishwasherSafe: triState,
      microwaveSafe: triState,
      ovenSafe: triState,
      freezerSafe: triState,
      notes: { type: String, maxlength: 1000 },
    },
    manufacturer: { name: String, address: String, countryOfOrigin: { type: String, default: 'India' } },
    supplier: { type: ObjectId, ref: 'Supplier' },
    isFragile: { type: Boolean, default: true },
    packaging: { requirements: [{ type: String, enum: PACKAGING_REQUIREMENTS }], notes: { type: String, maxlength: 500 } },
    giftWrapAvailable: { type: Boolean, default: false },
    returnPolicy: {
      returnable: { type: Boolean, default: true },
      windowDays: { type: Number, min: 0, max: 60 },
      replacementOnly: { type: Boolean, default: false },
      notes: { type: String, maxlength: 500 },
    },
    tax: { hsnCode: { type: String, maxlength: 10 }, gstRateBps: { type: Number, min: 0, max: 2800 } },
    seo: seoSchema,
    rating: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 }, distribution: { type: [Number], default: [0, 0, 0, 0, 0] } },
    flags: { featured: { type: Boolean, default: false }, bestseller: { type: Boolean, default: false }, newArrival: { type: Boolean, default: false } },
    status: { type: String, enum: Object.values(PRODUCT_STATUS), default: PRODUCT_STATUS.DRAFT },
    // Denormalised for fast listing/filtering; maintained by product + inventory services.
    priceMin: { type: Number, default: 0 },
    priceMax: { type: Number, default: 0 },
    maxDiscountBps: { type: Number, default: 0 },
    inStock: { type: Boolean, default: false },
    salesCount: { type: Number, default: 0 },
    publishedAt: Date,
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ 'variants.sku': 1 }, { unique: true });
productSchema.index({ name: 'text', brand: 'text', tags: 'text', 'variants.sku': 'text', description: 'text' }, {
  weights: { name: 10, 'variants.sku': 8, brand: 5, tags: 5, description: 1 },
  name: 'product_text',
});
productSchema.index({ status: 1, categoryPath: 1, priceMin: 1 });
productSchema.index({ status: 1, salesCount: -1 });
productSchema.index({ status: 1, publishedAt: -1 });
productSchema.index({ status: 1, 'rating.average': -1 });
productSchema.index({ status: 1, maxDiscountBps: -1 });
productSchema.index({ status: 1, 'flags.featured': 1 });
productSchema.index({ collections: 1, status: 1 });
productSchema.index({ 'bundleItems.sku': 1 });
productSchema.index({ 'images.media': 1 });
productSchema.index({ 'images.replacement.media': 1 }, { sparse: true });
productSchema.index({ status: 1, updatedAt: -1 });

/** Fields never exposed on public endpoints. */
productSchema.statics.PUBLIC_PROJECTION = '-variants.costPrice -supplier -createdBy -updatedBy -__v';

/** Gallery entries that may be shown publicly: approved (or allow-listed external) and not pending. */
productSchema.statics.publicImages = (images = []) =>
  images
    .filter((i) => i && i.url && !i.pending)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map(({ url, thumbUrl, mediumUrl, alt, sortOrder, credit }) => ({ url, thumbUrl, mediumUrl, alt, sortOrder, ...(credit?.provider ? { credit } : {}) }));

module.exports = mongoose.model('Product', productSchema);
