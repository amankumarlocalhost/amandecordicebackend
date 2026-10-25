'use strict';

const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

const revisionSchema = new mongoose.Schema(
  { version: Number, data: Mixed, publishedAt: Date, publishedBy: { type: ObjectId, ref: 'User' } },
  { _id: false },
);

/**
 * One document per content block (homepage, footer, announcement, navigation). Editors work on
 * `draft`; the storefront only ever reads `published`. draftVersion increments on every save and is
 * used for optimistic concurrency; history keeps recent published revisions for rollback.
 */
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    draft: { type: Mixed, default: null },
    draftVersion: { type: Number, default: 0 },
    draftUpdatedAt: Date,
    draftUpdatedBy: { type: ObjectId, ref: 'User' },
    published: { type: Mixed, default: null },
    publishedVersion: { type: Number, default: 0 },
    publishedAt: Date,
    publishedBy: { type: ObjectId, ref: 'User' },
    history: { type: [revisionSchema], default: [] },
    mediaRefs: [{ type: ObjectId, ref: 'Upload' }], // every upload used by draft, published or history
  },
  { timestamps: true, minimize: false },
);
siteContentSchema.index({ key: 1 }, { unique: true });
siteContentSchema.index({ mediaRefs: 1 });

/** Informational pages (about, care guide, policies…). Same draft/published model as SiteContent. */
const pageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, lowercase: true, trim: true },
    draft: { type: Mixed, required: true },
    draftVersion: { type: Number, default: 1 },
    draftUpdatedAt: Date,
    draftUpdatedBy: { type: ObjectId, ref: 'User' },
    published: { type: Mixed, default: null },
    publishedVersion: { type: Number, default: 0 },
    publishedAt: Date,
    publishedBy: { type: ObjectId, ref: 'User' },
    status: { type: String, enum: ['draft', 'published', 'unpublished'], default: 'draft' },
    showInFooter: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    history: { type: [revisionSchema], default: [] },
    mediaRefs: [{ type: ObjectId, ref: 'Upload' }],
  },
  { timestamps: true, minimize: false },
);
pageSchema.index({ slug: 1 }, { unique: true });
pageSchema.index({ status: 1, sortOrder: 1 });
pageSchema.index({ mediaRefs: 1 });

const SiteContent = mongoose.model('SiteContent', siteContentSchema);
const Page = mongoose.model('Page', pageSchema);

module.exports = { SiteContent, Page };
