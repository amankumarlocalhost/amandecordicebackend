'use strict';

const mongoose = require('mongoose');

const seoSchema = new mongoose.Schema(
  { title: { type: String, maxlength: 70 }, description: { type: String, maxlength: 170 }, keywords: [{ type: String, maxlength: 40 }] },
  { _id: false },
);

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
    level: { type: Number, default: 0, min: 0, max: 3 },
    description: { type: String, maxlength: 2000 },
    image: { media: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' }, url: String, key: String, mediumUrl: String, thumbUrl: String, alt: { type: String, maxlength: 160 } },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    seo: seoSchema,
  },
  { timestamps: true },
);
categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ parent: 1, sortOrder: 1 });
categorySchema.index({ ancestors: 1 });
categorySchema.index({ 'image.media': 1 }, { sparse: true });

module.exports = mongoose.model('Category', categorySchema);
module.exports.seoSchema = seoSchema;
