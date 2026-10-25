'use strict';

const env = require('../../config/env');
const cache = require('../../services/cache');
const sync = require('../../services/sync');
const audit = require('../audit/audit');
const media = require('../media/media.service');
const { SiteContent, Page } = require('./content.models');
const { CONTENT_KEYS, page: pageSchema, collectImageRefs } = require('./content.schemas');
const { badRequest, notFound, conflict, unauthorized } = require('../../utils/errors');
const { hmacSha256, safeEqual } = require('../../utils/crypto');

const HISTORY_LIMIT = 10;
const STALE = (what) => conflict(`This ${what} was changed by someone else since you opened it. Reload to see the latest version.`, 'STALE_WRITE');

/** Replaces every image reference with its approved-media record (in place) and returns the upload ids used. */
async function resolveImages(data) {
  const refs = collectImageRefs(data);
  for (const r of refs) {
    const resolved = await media.resolveApprovedImage({ media: r.media, url: r.url, alt: r.alt });
    for (const k of Object.keys(r)) delete r[k];
    Object.assign(r, resolved);
  }
  return [...new Set(refs.map((r) => r.media && String(r.media)).filter(Boolean))];
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------------------ preview tokens

/** Short-lived token that lets the storefront render a draft (for the admin "Preview" button). */
function previewToken(subject, ttlSec = 15 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = Buffer.from(JSON.stringify({ s: subject, exp })).toString('base64url');
  return { token: `${body}.${hmacSha256(env.COOKIE_SECRET, `preview:${body}`).slice(0, 43)}`, expiresAt: new Date(exp * 1000) };
}

function verifyPreviewToken(token, subject) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(sig, hmacSha256(env.COOKIE_SECRET, `preview:${body}`).slice(0, 43))) throw unauthorized('Invalid preview link', 'PREVIEW_INVALID');
  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Invalid preview link', 'PREVIEW_INVALID');
  }
  if (p.s !== subject || p.exp < Date.now() / 1000) throw unauthorized('This preview link has expired', 'PREVIEW_EXPIRED');
}

// ------------------------------------------------------------------ site content blocks

function blockDto(doc, key) {
  return {
    key,
    draft: doc?.draft ?? null,
    draftVersion: doc?.draftVersion || 0,
    draftUpdatedAt: doc?.draftUpdatedAt || null,
    draftUpdatedBy: doc?.draftUpdatedBy || null,
    published: doc?.published ?? null,
    publishedVersion: doc?.publishedVersion || 0,
    publishedAt: doc?.publishedAt || null,
    publishedBy: doc?.publishedBy || null,
    hasUnpublishedChanges: Boolean(doc && doc.draftVersion !== doc.publishedVersion),
    history: (doc?.history || []).map((h) => ({ version: h.version, publishedAt: h.publishedAt, publishedBy: h.publishedBy })).reverse(),
  };
}

async function getBlock(key) {
  if (!CONTENT_KEYS[key]) throw notFound('Content block');
  const doc = await SiteContent.findOne({ key }).populate('draftUpdatedBy', 'name').populate('publishedBy', 'name').populate('history.publishedBy', 'name').lean();
  return blockDto(doc, key);
}

async function saveDraft(key, data, baseVersion, req) {
  const schema = CONTENT_KEYS[key];
  if (!schema) throw notFound('Content block');
  const parsed = clone(schema.parse(clone(data)));
  const mediaIds = await resolveImages(parsed);
  try {
    const doc = await SiteContent.findOneAndUpdate(
      { key, draftVersion: baseVersion },
      { $set: { draft: parsed, draftUpdatedAt: new Date(), draftUpdatedBy: req.auth.userId }, $inc: { draftVersion: 1 }, $addToSet: { mediaRefs: { $each: mediaIds } } },
      { new: true, upsert: baseVersion === 0 },
    ).lean();
    if (!doc) throw STALE('content');
    await audit.record({ req, action: 'content.draft', resource: { type: 'content', id: key }, metadata: { version: doc.draftVersion } });
    return blockDto(doc, key);
  } catch (err) {
    if (err.code === 11000) throw STALE('content');
    throw err;
  }
}

function announce(key) {
  sync.changed({ tags: [sync.TAGS.content(key)], events: [{ event: key === 'homepage' ? sync.EVENTS.HOMEPAGE_UPDATED : sync.EVENTS.CONTENT_UPDATED, key }] });
}

async function publish(key, version, req) {
  const schema = CONTENT_KEYS[key];
  if (!schema) throw notFound('Content block');
  const doc = await SiteContent.findOne({ key }).lean();
  if (!doc?.draft) throw badRequest('Nothing to publish yet — save a draft first');
  if (doc.draftVersion !== version) throw STALE('content');
  // Re-validate and re-resolve at publish time: every image must still be an approved asset.
  const data = clone(schema.parse(clone(doc.draft)));
  const mediaIds = await resolveImages(data);
  const now = new Date();
  const updated = await SiteContent.findOneAndUpdate(
    { key, draftVersion: version },
    {
      $set: { published: data, draft: data, publishedVersion: version, publishedAt: now, publishedBy: req.auth.userId },
      $push: { history: { $each: [{ version, data, publishedAt: now, publishedBy: req.auth.userId }], $slice: -HISTORY_LIMIT } },
      $addToSet: { mediaRefs: { $each: mediaIds } },
    },
    { new: true },
  ).lean();
  if (!updated) throw STALE('content');
  await cache.bump(cache.NS.CONTENT);
  await audit.record({ req, action: 'content.publish', resource: { type: 'content', id: key }, metadata: { version } });
  announce(key);
  return blockDto(updated, key);
}

async function discardDraft(key, req) {
  const doc = await SiteContent.findOne({ key });
  if (!doc) throw notFound('Content block');
  doc.draft = doc.published;
  doc.draftVersion = doc.publishedVersion;
  doc.draftUpdatedAt = new Date();
  doc.draftUpdatedBy = req.auth.userId;
  await doc.save();
  await audit.record({ req, action: 'content.discard', resource: { type: 'content', id: key } });
  return blockDto(doc.toObject(), key);
}

/** Re-publishes an earlier revision as a new version (history is never rewritten). */
async function rollback(key, version, req) {
  const doc = await SiteContent.findOne({ key }).lean();
  const rev = doc?.history?.find((h) => h.version === version);
  if (!rev) throw notFound('Revision');
  const saved = await saveDraft(key, rev.data, doc.draftVersion, req);
  const out = await publish(key, saved.draftVersion, req);
  await audit.record({ req, action: 'content.rollback', resource: { type: 'content', id: key }, metadata: { restored: version, as: out.publishedVersion } });
  return out;
}

async function getPublished(key) {
  if (!CONTENT_KEYS[key]) throw notFound('Content block');
  return cache.wrap(cache.NS.CONTENT, `block:${key}`, 300, async () => {
    const doc = await SiteContent.findOne({ key }).select('published publishedVersion publishedAt').lean();
    return { key, data: doc?.published ?? null, version: doc?.publishedVersion || 0, publishedAt: doc?.publishedAt || null };
  });
}

async function getDraftForPreview(key, token) {
  if (!CONTENT_KEYS[key]) throw notFound('Content block');
  verifyPreviewToken(token, `content:${key}`);
  const doc = await SiteContent.findOne({ key }).select('draft draftVersion').lean();
  return { key, data: doc?.draft ?? null, version: doc?.draftVersion || 0, preview: true };
}

// ------------------------------------------------------------------ pages

const RESERVED_SLUGS = new Set(['shop', 'cart', 'checkout', 'account', 'login', 'register', 'products', 'category', 'collections', 'api', 'admin', 'preview', 'help', 'search']);

function pageDto(p, { full = true } = {}) {
  return {
    id: p._id,
    slug: p.slug,
    status: p.status,
    title: p.draft?.title,
    publishedTitle: p.published?.title || null,
    showInFooter: p.showInFooter,
    sortOrder: p.sortOrder,
    draftVersion: p.draftVersion,
    publishedVersion: p.publishedVersion,
    hasUnpublishedChanges: p.status !== 'published' || p.draftVersion !== p.publishedVersion,
    draftUpdatedAt: p.draftUpdatedAt,
    draftUpdatedBy: p.draftUpdatedBy,
    publishedAt: p.publishedAt,
    publishedBy: p.publishedBy,
    updatedAt: p.updatedAt,
    ...(full ? { draft: p.draft, published: p.published, history: (p.history || []).map((h) => ({ version: h.version, publishedAt: h.publishedAt, publishedBy: h.publishedBy })).reverse() } : {}),
  };
}

function checkSlug(slug) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw badRequest('Slug may contain lowercase letters, digits and hyphens');
  if (RESERVED_SLUGS.has(slug)) throw badRequest(`"${slug}" is reserved`);
}

async function createPage({ slug, showInFooter, sortOrder, ...data }, req) {
  checkSlug(slug);
  const draft = clone(pageSchema.parse(data));
  const mediaRefs = await resolveImages(draft);
  try {
    const p = await Page.create({ slug, draft, showInFooter, sortOrder, draftUpdatedAt: new Date(), draftUpdatedBy: req.auth.userId, mediaRefs });
    await audit.record({ req, action: 'page.create', resource: { type: 'page', id: p._id }, metadata: { slug } });
    return pageDto(p.toObject());
  } catch (err) {
    if (err.code === 11000) throw conflict('A page with this slug already exists', 'DUPLICATE');
    throw err;
  }
}

async function savePageDraft(id, { baseVersion, slug, showInFooter, sortOrder, ...data }, req) {
  const draft = clone(pageSchema.parse(data));
  const mediaRefs = await resolveImages(draft);
  const set = { draft, draftUpdatedAt: new Date(), draftUpdatedBy: req.auth.userId };
  if (showInFooter !== undefined) set.showInFooter = showInFooter;
  if (sortOrder !== undefined) set.sortOrder = sortOrder;
  const before = await Page.findById(id).select('slug status').lean();
  if (!before) throw notFound('Page');
  if (slug && slug !== before.slug) {
    if (before.status === 'published') throw badRequest('Unpublish the page before changing its URL');
    checkSlug(slug);
    set.slug = slug;
  }
  try {
    const p = await Page.findOneAndUpdate({ _id: id, draftVersion: baseVersion }, { $set: set, $inc: { draftVersion: 1 }, $addToSet: { mediaRefs: { $each: mediaRefs } } }, { new: true }).lean();
    if (!p) throw STALE('page');
    await audit.record({ req, action: 'page.draft', resource: { type: 'page', id }, metadata: { version: p.draftVersion } });
    return pageDto(p);
  } catch (err) {
    if (err.code === 11000) throw conflict('A page with this slug already exists', 'DUPLICATE');
    throw err;
  }
}

function announcePage(slug) {
  sync.changed({ tags: [sync.TAGS.PAGES, sync.TAGS.page(slug)], events: [{ event: sync.EVENTS.PAGE_UPDATED, slug }] });
}

async function publishPage(id, version, req) {
  const p = await Page.findById(id).lean();
  if (!p) throw notFound('Page');
  if (p.draftVersion !== version) throw STALE('page');
  const data = clone(pageSchema.parse(clone(p.draft)));
  const mediaRefs = await resolveImages(data);
  const now = new Date();
  const updated = await Page.findOneAndUpdate(
    { _id: id, draftVersion: version },
    {
      $set: { published: data, draft: data, publishedVersion: version, publishedAt: now, publishedBy: req.auth.userId, status: 'published' },
      $push: { history: { $each: [{ version, data, publishedAt: now, publishedBy: req.auth.userId }], $slice: -HISTORY_LIMIT } },
      $addToSet: { mediaRefs: { $each: mediaRefs } },
    },
    { new: true },
  ).lean();
  if (!updated) throw STALE('page');
  await cache.bump(cache.NS.CONTENT);
  await audit.record({ req, action: 'page.publish', resource: { type: 'page', id }, metadata: { slug: p.slug, version } });
  announcePage(p.slug);
  return pageDto(updated);
}

async function unpublishPage(id, req) {
  const p = await Page.findOneAndUpdate({ _id: id, status: 'published' }, { $set: { status: 'unpublished' } }, { new: true }).lean();
  if (!p) throw badRequest('Page is not published');
  await cache.bump(cache.NS.CONTENT);
  await audit.record({ req, action: 'page.unpublish', resource: { type: 'page', id }, metadata: { slug: p.slug } });
  announcePage(p.slug);
  return pageDto(p);
}

async function deletePage(id, req) {
  const p = await Page.findById(id).lean();
  if (!p) throw notFound('Page');
  if (p.status === 'published') throw conflict('Unpublish the page before deleting it', 'PAGE_PUBLISHED');
  await Page.deleteOne({ _id: id });
  await audit.record({ req, action: 'page.delete', resource: { type: 'page', id }, metadata: { slug: p.slug } });
}

async function listPublishedPages() {
  return cache.wrap(cache.NS.CONTENT, 'pages', 300, async () => {
    const rows = await Page.find({ status: 'published' }).sort({ sortOrder: 1, slug: 1 }).select('slug published.title published.summary showInFooter publishedAt').lean();
    return rows.map((p) => ({ slug: p.slug, title: p.published?.title, summary: p.published?.summary, showInFooter: p.showInFooter, publishedAt: p.publishedAt }));
  });
}

async function getPublishedPage(slug) {
  const p = await cache.wrap(cache.NS.CONTENT, `page:${slug}`, 300, async () => {
    const doc = await Page.findOne({ slug, status: 'published' }).select('slug published publishedAt').lean();
    return doc ? { slug: doc.slug, ...doc.published, publishedAt: doc.publishedAt } : null;
  });
  if (!p) throw notFound('Page');
  return p;
}

async function getPageDraftForPreview(slug, token) {
  verifyPreviewToken(token, `page:${slug}`);
  const p = await Page.findOne({ slug }).select('slug draft').lean();
  if (!p) throw notFound('Page');
  return { slug: p.slug, ...p.draft, preview: true };
}

module.exports = {
  getBlock,
  saveDraft,
  publish,
  discardDraft,
  rollback,
  getPublished,
  getDraftForPreview,
  previewToken,
  verifyPreviewToken,
  createPage,
  savePageDraft,
  publishPage,
  unpublishPage,
  deletePage,
  listPublishedPages,
  getPublishedPage,
  getPageDraftForPreview,
  pageDto,
};
