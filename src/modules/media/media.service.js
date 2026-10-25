'use strict';

const crypto = require('crypto');
const path = require('path');
const sharp = require('sharp');
const env = require('../../config/env');
const logger = require('../../config/logger');
const storage = require('../../services/storage');
const cloudinary = require('../../services/cloudinary');
const unsplash = require('../../services/unsplash');
const cache = require('../../services/cache');
const sync = require('../../services/sync');
const audit = require('../audit/audit');
const { Upload, CATALOG_PURPOSES } = require('./media.model');
const { badRequest, notFound, conflict, forbidden, unavailable } = require('../../utils/errors');
const { hmacSha256, safeEqual } = require('../../utils/crypto');
const { MEDIA_STATUS, PRODUCT_STATUS } = require('../../constants/statuses');
const { ROLES } = require('../../constants/roles');

sharp.cache(false);
sharp.concurrency(2);

const ALLOWED_INPUT = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
const S = MEDIA_STATUS;

/** Container signatures: MP4/MOV have "ftyp" at byte 4; WebM/Matroska start with the EBML magic. */
function looksLikeVideo(buf) {
  if (buf.length < 12) return false;
  return buf.toString('ascii', 4, 8) === 'ftyp' || (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3);
}

const folderFor = (purpose) => `${purpose}/${new Date().toISOString().slice(0, 7)}`;
const sizeKeys = (key) => ({ large: key, medium: key.replace(/\.webp$/, '_m.webp'), thumb: key.replace(/\.webp$/, '_t.webp') });

/** Keeps a display-safe original filename: no path, no control characters, bounded length. */
function cleanName(name) {
  if (!name) return undefined;
  return path
    .basename(String(name))
    .replace(/[\u0000-\u001f\u007f<>"'`]/g, '')
    .slice(0, 150);
}

// ------------------------------------------------------------------ processing

/**
 * The declared MIME type is not trusted: Sharp decodes the bytes, rejects anything that is not a
 * real image, strips metadata (EXIF/GPS) and re-encodes to WebP. With Cloudinary the sanitised master
 * is uploaded and display sizes are served as transformations; otherwise three sizes are stored.
 * `review: true` (catalog uploads) stores the asset privately in pending_review.
 */
async function processImage(buffer, { purpose, ownerId, review = false, originalName, minDimension = 0, target, replaces }) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw badRequest('File is not a valid image');
  }
  if (!ALLOWED_INPUT.has(meta.format)) throw badRequest(`Unsupported image format: ${meta.format}`);
  if (minDimension && (Math.min(meta.width || 0, meta.height || 0) < minDimension)) {
    throw badRequest(`Image is too small (${meta.width}×${meta.height}). Minimum is ${minDimension}px on each side.`, undefined, 'IMAGE_TOO_SMALL');
  }

  const id = crypto.randomUUID();
  const pipeline = (w) => sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 85 });
  const base = {
    owner: ownerId,
    purpose,
    kind: 'image',
    originalName: cleanName(originalName),
    isPrivate: review,
    ...(review ? { review: { status: S.PENDING_REVIEW }, history: [{ action: 'uploaded', by: ownerId }] } : {}),
    ...(target ? { target } : {}),
    ...(replaces ? { replaces } : {}),
  };

  if (env.STORAGE_DRIVER === 'cloudinary') {
    const master = await pipeline(2000).toBuffer();
    const res = await cloudinary.upload(master, { resourceType: 'image', folder: folderFor(purpose), publicId: id, type: review ? 'authenticated' : 'upload' });
    return Upload.create({
      ...base,
      provider: 'cloudinary',
      key: res.public_id,
      version: res.version,
      ...(review ? {} : cloudinary.imageUrls(res.public_id, res.version)),
      width: res.width,
      height: res.height,
      bytes: res.bytes,
      contentType: `image/${res.format}`,
    });
  }

  const key = `${folderFor(purpose)}/${id}.webp`;
  const k = sizeKeys(key);
  const [large, medium, thumb] = await Promise.all([pipeline(1600).toBuffer({ resolveWithObject: true }), pipeline(800).toBuffer(), pipeline(300).toBuffer()]);
  const opts = { private: review };
  const [l, m, t] = await Promise.all([
    storage.put(k.large, large.data, 'image/webp', opts),
    storage.put(k.medium, medium, 'image/webp', opts),
    storage.put(k.thumb, thumb, 'image/webp', opts),
  ]);
  return Upload.create({
    ...base,
    provider: env.STORAGE_DRIVER,
    key: l.key,
    ...(review ? {} : { url: l.url, mediumUrl: m.url, thumbUrl: t.url }),
    width: large.info.width,
    height: large.info.height,
    bytes: large.info.size,
    contentType: 'image/webp',
  });
}

/** Videos are stored on Cloudinary only (it transcodes, streams and makes posters). */
async function processVideo(buffer, { purpose, ownerId, review = false, originalName, target, replaces }) {
  if (env.STORAGE_DRIVER !== 'cloudinary') throw badRequest('Video uploads require STORAGE_DRIVER=cloudinary', undefined, 'VIDEO_NOT_SUPPORTED');
  if (buffer.length > env.MEDIA_MAX_VIDEO_MB * 1024 * 1024) throw badRequest(`Videos can be at most ${env.MEDIA_MAX_VIDEO_MB} MB`);
  if (!looksLikeVideo(buffer)) throw badRequest('File is not a valid MP4, MOV or WebM video');
  const type = review ? 'authenticated' : 'upload';
  let res;
  try {
    res = await cloudinary.upload(buffer, { resourceType: 'video', folder: folderFor(purpose), publicId: crypto.randomUUID(), type });
  } catch (err) {
    if (err.status && err.status < 500) throw badRequest('The video could not be processed');
    throw err;
  }
  if (res.duration > env.MEDIA_MAX_VIDEO_SECONDS) {
    await cloudinary.destroy(res.public_id, 'video', type).catch((e) => logger.warn({ e: e.message }, 'cloudinary cleanup failed'));
    throw badRequest(`Videos can be at most ${env.MEDIA_MAX_VIDEO_SECONDS} seconds long`, undefined, 'VIDEO_TOO_LONG');
  }
  return Upload.create({
    owner: ownerId,
    purpose,
    kind: 'video',
    provider: 'cloudinary',
    key: res.public_id,
    version: res.version,
    ...(review ? {} : cloudinary.videoUrls(res.public_id, res.version)),
    durationSec: Math.round(res.duration * 10) / 10,
    width: res.width,
    height: res.height,
    bytes: res.bytes,
    contentType: `video/${res.format}`,
    originalName: cleanName(originalName),
    isPrivate: review,
    ...(review ? { review: { status: S.PENDING_REVIEW }, history: [{ action: 'uploaded', by: ownerId }] } : {}),
    ...(target ? { target } : {}),
    ...(replaces ? { replaces } : {}),
  });
}

async function removeUpload(u) {
  if (u.provider === 'unsplash') return undefined; // hotlinked: nothing of ours to delete
  if (u.provider === 'cloudinary') return cloudinary.destroy(u.key, u.kind === 'video' ? 'video' : 'image', u.isPrivate ? 'authenticated' : 'upload');
  const k = sizeKeys(u.key);
  for (const key of [k.large, k.medium, k.thumb]) await storage.remove(key, { private: Boolean(u.isPrivate) }).catch(() => {});
}

// ------------------------------------------------------------------ private previews

const previewSig = (id, size, exp) => hmacSha256(env.COOKIE_SECRET, `media-preview:${id}:${size}:${exp}`).slice(0, 43);

/**
 * Preview URLs for staff. Public assets use their public URLs; private ones get short-lived signed
 * URLs (our own endpoint for local/S3 storage, Cloudinary signed delivery for authenticated assets).
 */
function previewUrls(u) {
  // Hotlinked photos are already public on Unsplash; "private" only means not on our storefront yet.
  if (u.provider === 'unsplash' && u.source?.rawUrl) {
    const s = unsplash.urls(u.source.rawUrl);
    return { thumb: s.thumbUrl, medium: s.mediumUrl, large: s.url };
  }
  if (!u.isPrivate) return { thumb: u.thumbUrl || u.posterUrl || u.url, medium: u.mediumUrl || u.url, large: u.url, video: u.kind === 'video' ? u.url : undefined };
  if (u.provider === 'cloudinary') {
    if (u.kind === 'video') {
      return {
        thumb: cloudinary.privateUrl(u.key, { resourceType: 'video', version: u.version, width: 300, format: 'jpg' }),
        medium: cloudinary.privateUrl(u.key, { resourceType: 'video', version: u.version, width: 800, format: 'jpg' }),
        large: cloudinary.privateUrl(u.key, { resourceType: 'video', version: u.version, width: 1280, format: 'jpg' }),
        video: cloudinary.privateUrl(u.key, { resourceType: 'video', version: u.version, width: 1280, format: 'mp4' }),
      };
    }
    return {
      thumb: cloudinary.privateUrl(u.key, { version: u.version, width: 300 }),
      medium: cloudinary.privateUrl(u.key, { version: u.version, width: 800 }),
      large: cloudinary.privateUrl(u.key, { version: u.version, width: 1600 }),
    };
  }
  const exp = Math.floor(Date.now() / 1000) + env.MEDIA_PREVIEW_TTL_SEC;
  const link = (size) => `${env.APP_URL.replace(/\/$/, '')}/api/v1/media/preview/${u._id}/${size}?exp=${exp}&sig=${previewSig(String(u._id), size, exp)}`;
  return { thumb: link('thumb'), medium: link('medium'), large: link('large'), expiresAt: new Date(exp * 1000) };
}

/** Validates a signed preview link and returns the bytes (null when invalid/expired/missing). */
async function readPreview(id, size, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Date.now() / 1000 || e > Date.now() / 1000 + 3600 * 24) return null;
  if (typeof sig !== 'string' || !safeEqual(sig, previewSig(id, size, e))) return null;
  const u = await Upload.findOne({ _id: id, purpose: { $in: CATALOG_PURPOSES }, kind: 'image', provider: { $in: ['local', 's3'] } }).lean();
  if (!u) return null;
  const buf = await storage.read(sizeKeys(u.key)[size], { private: Boolean(u.isPrivate) });
  return buf ? { buffer: buf, contentType: 'image/webp' } : null;
}

// ------------------------------------------------------------------ DTOs

const toDto = (u) => ({ id: u._id, kind: u.kind || 'image', url: u.url, mediumUrl: u.mediumUrl, thumbUrl: u.thumbUrl, posterUrl: u.posterUrl, durationSec: u.durationSec, width: u.width, height: u.height });

/** Compact reference stored on returns, reviews and chat messages. */
const toRef = (u) => ({ upload: u._id, kind: u.kind || 'image', url: u.url, thumbUrl: u.thumbUrl, posterUrl: u.posterUrl });

function adminDto(u) {
  return {
    id: u._id,
    kind: u.kind || 'image',
    purpose: u.purpose,
    status: u.review?.status || null,
    review: u.review || null,
    originalName: u.originalName,
    width: u.width,
    height: u.height,
    bytes: u.bytes,
    durationSec: u.durationSec,
    contentType: u.contentType,
    provider: u.provider,
    storageId: u.key,
    isPrivate: Boolean(u.isPrivate),
    // Public URLs exist only once approved; previews are signed and short-lived while private.
    url: u.isPrivate ? null : u.url,
    thumbUrl: u.isPrivate ? null : u.thumbUrl,
    mediumUrl: u.isPrivate ? null : u.mediumUrl,
    posterUrl: u.isPrivate ? null : u.posterUrl,
    preview: previewUrls(u),
    owner: u.owner && typeof u.owner === 'object' && u.owner.name ? { id: u.owner._id, name: u.owner.name } : { id: u.owner },
    target: u.target?.type ? u.target : null,
    source: u.source?.provider ? u.source : null,
    replaces: u.replaces || null,
    replacedBy: u.replacedBy || null,
    history: u.history || [],
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

// ------------------------------------------------------------------ references

/** Where an upload is used. Deleting or cleaning up a referenced asset is refused. */
async function findReferences(uploadId) {
  const id = String(uploadId);
  const Product = require('../products/product.model');
  const Category = require('../categories/category.model');
  const Collection = require('../collections/collection.model');
  const { Campaign } = require('../promotions/promotion.models');
  const { SiteContent, Page } = require('../content/content.models');
  const [products, categories, collections, campaigns, content, pages] = await Promise.all([
    Product.find({ $or: [{ 'images.media': id }, { 'images.replacement.media': id }, { 'images.previous.media': id }, { 'videos.media': id }] }).select('name slug status').limit(50).lean(),
    Category.find({ 'image.media': id }).select('name slug').lean(),
    Collection.find({ 'image.media': id }).select('name slug').lean(),
    Campaign.find({ $or: [{ 'banner.media': id }, { 'banner.mobileMedia': id }] }).select('name slug').lean(),
    SiteContent.find({ mediaRefs: id }).select('key').lean(),
    Page.find({ mediaRefs: id }).select('title slug status').lean(),
  ]);
  const refs = [
    ...products.map((p) => ({ type: 'product', id: p._id, name: p.name, slug: p.slug, status: p.status })),
    ...categories.map((c) => ({ type: 'category', id: c._id, name: c.name, slug: c.slug })),
    ...collections.map((c) => ({ type: 'collection', id: c._id, name: c.name, slug: c.slug })),
    ...campaigns.map((c) => ({ type: 'campaign', id: c._id, name: c.name, slug: c.slug })),
    ...content.map((c) => ({ type: 'content', id: c.key, name: c.key })),
    ...pages.map((p) => ({ type: 'page', id: p._id, name: p.title, slug: p.slug, status: p.status })),
  ];
  return refs;
}

// ------------------------------------------------------------------ review workflow

const isCatalog = (u) => CATALOG_PURPOSES.includes(u.purpose);

/** Reviewers may not approve their own uploads unless they are a super admin (separation of duties). */
function assertCanReview(u, req) {
  if (String(u.owner?._id || u.owner) === String(req.auth.userId) && req.auth.role !== ROLES.SUPER_ADMIN) {
    throw forbidden('You cannot review media you uploaded. Ask another reviewer.', 'SELF_REVIEW');
  }
}

async function makePublic(u) {
  if (u.provider === 'unsplash') return unsplash.urls(u.source.rawUrl);
  if (u.provider === 'cloudinary') {
    const res = await cloudinary.publish(u.key, u.kind === 'video' ? 'video' : 'image');
    const version = res?.version || u.version;
    return { version, ...(u.kind === 'video' ? cloudinary.videoUrls(u.key, version) : cloudinary.imageUrls(u.key, version)) };
  }
  const k = sizeKeys(u.key);
  const [l, m, t] = [await storage.promote(k.large), await storage.promote(k.medium), await storage.promote(k.thumb)];
  return { url: l.url, mediumUrl: m.url, thumbUrl: t.url };
}

/** After approval, pending gallery entries and pending replacements pointing at the asset get its public URLs. */
async function propagateApproval(u) {
  const Product = require('../products/product.model');
  const id = u._id;
  const urls = { url: u.url, mediumUrl: u.mediumUrl, thumbUrl: u.thumbUrl };
  await Product.updateMany(
    { 'images.media': id },
    { $set: { 'images.$[e].url': urls.url, 'images.$[e].mediumUrl': urls.mediumUrl, 'images.$[e].thumbUrl': urls.thumbUrl, 'images.$[e].pending': false } },
    { arrayFilters: [{ 'e.media': id }] },
  );
  await Product.updateMany(
    { 'images.replacement.media': id },
    { $set: { 'images.$[e].replacement.url': urls.url, 'images.$[e].replacement.mediumUrl': urls.mediumUrl, 'images.$[e].replacement.thumbUrl': urls.thumbUrl, 'images.$[e].replacement.ready': true } },
    { arrayFilters: [{ 'e.replacement.media': id }] },
  );
  const live = await Product.find({ 'images.media': id, status: PRODUCT_STATUS.ACTIVE }).select('_id slug').lean();
  if (live.length) {
    await cache.bump(cache.NS.CATALOG);
    sync.changed({
      tags: [sync.TAGS.CATALOG, ...live.map((p) => sync.TAGS.product(p.slug))],
      events: live.map((p) => ({ event: sync.EVENTS.PRODUCT_UPDATED, id: String(p._id), slug: p.slug })),
    });
  }
  return live.length;
}

async function approve(id, req) {
  const u = await Upload.findById(id);
  if (!u || !isCatalog(u)) throw notFound('Media');
  if (u.review?.status !== S.PENDING_REVIEW) throw conflict(`Only media pending review can be approved (current: ${u.review?.status})`, 'INVALID_MEDIA_STATE');
  assertCanReview(u, req);
  // Claim first so concurrent reviewers cannot both act; files move to public storage only after the claim.
  const claimed = await Upload.findOneAndUpdate(
    { _id: u._id, 'review.status': S.PENDING_REVIEW },
    { $set: { 'review.status': S.APPROVED, 'review.reviewedBy': req.auth.userId, 'review.reviewedAt': new Date(), 'review.reason': undefined, 'review.replacementRequested': false } },
    { new: true },
  );
  if (!claimed) throw conflict('This media was reviewed by someone else just now', 'INVALID_MEDIA_STATE');
  let pub;
  try {
    pub = await makePublic(claimed);
  } catch (err) {
    logger.error({ err: err.message, id: String(u._id) }, 'media publish failed; reverting approval');
    await Upload.updateOne({ _id: u._id }, { $set: { 'review.status': S.PENDING_REVIEW }, $unset: { 'review.reviewedBy': 1, 'review.reviewedAt': 1 } });
    throw unavailable('Storage is unavailable; the media is still pending. Please retry.', 'STORAGE_UNAVAILABLE');
  }
  claimed.set({ ...pub, isPrivate: false });
  claimed.history = [...(claimed.history || []), { action: 'approved', by: req.auth.userId, note: req.body?.note }];
  await claimed.save();
  await audit.record({ req, action: 'media.approve', resource: { type: 'media', id: claimed._id }, metadata: { purpose: claimed.purpose, target: claimed.target } });
  await propagateApproval(claimed);
  notifyStaff();
  return claimed;
}

async function reject(id, { reason, requestReplacement = false }, req) {
  const u = await Upload.findById(id);
  if (!u || !isCatalog(u)) throw notFound('Media');
  if (u.review?.status !== S.PENDING_REVIEW) throw conflict(`Only media pending review can be rejected (current: ${u.review?.status})`, 'INVALID_MEDIA_STATE');
  assertCanReview(u, req);
  const done = await Upload.findOneAndUpdate(
    { _id: u._id, 'review.status': S.PENDING_REVIEW },
    {
      $set: { 'review.status': S.REJECTED, 'review.reviewedBy': req.auth.userId, 'review.reviewedAt': new Date(), 'review.reason': reason, 'review.replacementRequested': Boolean(requestReplacement) },
      $push: { history: { action: requestReplacement ? 'replacement_requested' : 'rejected', by: req.auth.userId, at: new Date(), note: reason } },
    },
    { new: true },
  );
  if (!done) throw conflict('This media was reviewed by someone else just now', 'INVALID_MEDIA_STATE');
  await audit.record({ req, action: 'media.reject', resource: { type: 'media', id: done._id }, metadata: { reason, requestReplacement } });
  notifyStaff();
  return done;
}

/** Bulk review: each item is processed independently and reported (no all-or-nothing). */
async function bulkReview({ ids, decision, reason, requestReplacement }, req) {
  const results = [];
  for (const id of ids) {
    try {
      if (decision === 'approve') await approve(id, req);
      else await reject(id, { reason, requestReplacement }, req);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, code: err.code || 'ERROR', message: err.expose ? err.message : 'Failed' });
    }
  }
  return results;
}

/**
 * Re-upload after rejection: the rejected asset was never public, so every draft reference to it is
 * pointed at the new pending upload straight away.
 */
async function supersedeRejected(oldUpload, newUpload, req) {
  const Product = require('../products/product.model');
  await Product.updateMany({ 'images.media': oldUpload._id }, { $set: { 'images.$[e].media': newUpload._id, 'images.$[e].pending': true } }, { arrayFilters: [{ 'e.media': oldUpload._id }] });
  await Product.updateMany({ 'images.replacement.media': oldUpload._id }, { $set: { 'images.$[e].replacement.media': newUpload._id, 'images.$[e].replacement.ready': false } }, { arrayFilters: [{ 'e.replacement.media': oldUpload._id }] });
  await Upload.updateOne({ _id: oldUpload._id }, { $set: { replacedBy: newUpload._id }, $push: { history: { action: 'reuploaded', by: req.auth.userId, at: new Date(), note: String(newUpload._id) } } });
}

// ------------------------------------------------------------------ imported (hotlinked) images

/** Attribution shown next to an imported photo on the storefront (Unsplash API guideline). */
function creditFor(u) {
  if (u.source?.provider !== 'unsplash') return null;
  return { provider: 'unsplash', author: u.source.author, authorUrl: unsplash.withUtm(u.source.authorUrl), pageUrl: unsplash.withUtm(u.source.pageUrl) };
}

/**
 * Registers a verified Unsplash photo as a catalog upload in pending_review. Like a staff upload it
 * stays off the storefront (no public URLs) until another reviewer approves it. Idempotent per photo.
 */
async function registerUnsplashImage({ photo, verification, ownerId, purpose = 'product', target, query, alt }) {
  if (!verification?.ok) throw badRequest(`Unsplash photo ${photo.id} was not verified`);
  const existing = await Upload.findOne({ 'source.provider': 'unsplash', 'source.photoId': photo.id, purpose });
  if (existing) return { upload: existing, created: false };
  const upload = await Upload.create({
    owner: ownerId,
    purpose,
    kind: 'image',
    provider: 'unsplash',
    key: `unsplash:${photo.id}`,
    width: photo.width,
    height: photo.height,
    bytes: verification.bytes,
    contentType: verification.contentType,
    originalName: cleanName(alt || photo.description || photo.id),
    isPrivate: true,
    review: { status: S.PENDING_REVIEW },
    history: [{ action: 'imported', by: ownerId, note: `Unsplash photo ${photo.id} by ${photo.author || 'unknown'} (query: ${query || '—'})`.slice(0, 500) }],
    ...(target ? { target } : {}),
    source: {
      provider: 'unsplash',
      photoId: photo.id,
      pageUrl: photo.pageUrl,
      rawUrl: photo.rawUrl,
      downloadLocation: photo.downloadLocation,
      author: photo.author?.slice(0, 120),
      authorUrl: photo.authorUrl,
      description: photo.description?.slice(0, 300),
      query: query?.slice(0, 120),
      verifiedAt: new Date(),
    },
  });
  notifyStaff();
  return { upload, created: true };
}

// ------------------------------------------------------------------ resolving references on writes

function isAllowedExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && env.mediaExternalHosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const NOT_APPROVED = 'Images must be uploaded through the media library and approved before they can be used here';

/**
 * Resolves `{ media?, url?, alt? }` to a stored image that is safe to show publicly: an APPROVED upload
 * (URLs always come from our record, never from the client) or an allow-listed external host.
 */
async function resolveApprovedImage(input, { kind = 'image', field = 'image', existing } = {}) {
  if (!input) return input;
  // Grandfathered: an image that is already live on this record (set before the review workflow
  // existed) may be kept unchanged. Only new images must be approved uploads.
  if (!input.media && existing?.url && input.url === existing.url) return { ...existing, ...(input.alt !== undefined ? { alt: input.alt } : {}) };
  let u = null;
  if (input.media) u = await Upload.findOne({ _id: input.media, purpose: { $in: CATALOG_PURPOSES } }).lean();
  else if (input.url) u = await Upload.findOne({ url: input.url, purpose: { $in: CATALOG_PURPOSES } }).lean();
  if (u) {
    if (u.kind !== kind) throw badRequest(`${field}: expected an ${kind}`);
    if (u.review?.status !== S.APPROVED && u.review?.status !== S.SUPERSEDED) throw badRequest(`${field}: ${NOT_APPROVED}`, undefined, 'MEDIA_NOT_APPROVED');
    return { media: u._id, url: u.url, mediumUrl: u.mediumUrl, thumbUrl: u.thumbUrl, ...(u.posterUrl ? { posterUrl: u.posterUrl } : {}), width: u.width, height: u.height, ...(input.alt !== undefined ? { alt: input.alt } : {}) };
  }
  if (input.media) throw badRequest(`${field}: media not found`);
  if (input.url && isAllowedExternal(input.url)) return { url: input.url, ...(input.alt !== undefined ? { alt: input.alt } : {}) };
  throw badRequest(`${field}: ${NOT_APPROVED}`, undefined, 'MEDIA_NOT_APPROVED');
}

/**
 * Product gallery: entries may reference media that is still pending review (hidden from the public
 * until approved). Rejected media cannot be attached. Existing entries keep their pending replacement
 * and rollback history when they are sent back unchanged.
 */
async function resolveGallery(inputs, existing = []) {
  const ids = inputs.filter((i) => i.media).map((i) => String(i.media));
  const byId = new Map((await Upload.find({ _id: { $in: ids }, purpose: { $in: CATALOG_PURPOSES } }).lean()).map((u) => [String(u._id), u]));
  const urlOnly = inputs.filter((i) => !i.media && i.url).map((i) => i.url);
  const byUrl = new Map((urlOnly.length ? await Upload.find({ url: { $in: urlOnly }, purpose: { $in: CATALOG_PURPOSES } }).lean() : []).map((u) => [u.url, u]));
  const old = new Map(existing.map((e) => [String(e._id), e.toObject ? e.toObject() : e]));

  return inputs.map((input, i) => {
    const u = input.media ? byId.get(String(input.media)) : byUrl.get(input.url);
    const prev = input._id ? old.get(String(input._id)) : null;
    let entry;
    if (u) {
      if (u.kind !== 'image') throw badRequest(`images[${i}]: expected an image`);
      const st = u.review?.status;
      if (st === S.REJECTED) throw badRequest(`images[${i}]: this image was rejected in review — upload a replacement`, undefined, 'MEDIA_REJECTED');
      const live = st === S.APPROVED || st === S.SUPERSEDED;
      entry = { media: u._id, pending: !live, ...(live ? { url: u.url, mediumUrl: u.mediumUrl, thumbUrl: u.thumbUrl } : { url: undefined, mediumUrl: undefined, thumbUrl: undefined }), ...(creditFor(u) ? { credit: creditFor(u) } : {}) };
    } else if (input.media) {
      throw badRequest(`images[${i}]: media not found`);
    } else if (prev && !prev.pending && prev.url && input.url === prev.url) {
      // Grandfathered live image (predates the review workflow): kept as is, never re-exposed differently.
      entry = { url: prev.url, thumbUrl: prev.thumbUrl, mediumUrl: prev.mediumUrl, ...(prev.media ? { media: prev.media } : {}), pending: false };
    } else if (input.url && isAllowedExternal(input.url)) {
      entry = { url: input.url, thumbUrl: isAllowedExternal(input.thumbUrl) ? input.thumbUrl : undefined, mediumUrl: isAllowedExternal(input.mediumUrl) ? input.mediumUrl : undefined, pending: false };
    } else {
      throw badRequest(`images[${i}]: ${NOT_APPROVED}`, undefined, 'MEDIA_NOT_APPROVED');
    }
    const keepHistory = prev && String(prev.media || prev.url) === String(entry.media || entry.url);
    return {
      ...(prev ? { _id: prev._id } : {}),
      ...entry,
      alt: input.alt,
      sortOrder: input.sortOrder ?? i,
      ...(keepHistory && prev.replacement?.media ? { replacement: prev.replacement } : {}),
      ...(keepHistory && prev.previous ? { previous: prev.previous } : {}),
    };
  });
}

/** Videos must be approved before they are attached (they appear publicly immediately). */
async function resolveVideos(inputs) {
  const out = [];
  for (const [i, v] of inputs.entries()) {
    const r = await resolveApprovedImage({ media: v.media, url: v.url }, { kind: 'video', field: `videos[${i}]` });
    out.push({ media: r.media, url: r.url, posterUrl: r.posterUrl, thumbUrl: r.thumbUrl, durationSec: v.durationSec, title: v.title, sortOrder: v.sortOrder ?? i });
  }
  if (out.some((v) => v.media)) {
    const docs = await Upload.find({ _id: { $in: out.filter((v) => v.media).map((v) => v.media) } }).select('durationSec').lean();
    for (const v of out) {
      const d = docs.find((x) => String(x._id) === String(v.media));
      if (d?.durationSec) v.durationSec = d.durationSec;
    }
  }
  return out;
}

/** Is this URL safe to use on the storefront (an approved upload or an allow-listed host)? */
async function isPublicSafeUrl(url) {
  if (isAllowedExternal(url)) return true;
  return Boolean(await Upload.exists({ $or: [{ url }, { mediumUrl: url }, { thumbUrl: url }], 'review.status': { $in: [S.APPROVED, S.SUPERSEDED] } }));
}

// ------------------------------------------------------------------ cleanup

/**
 * Removes abandoned assets after the retention period: rejected or never-reviewed uploads and
 * superseded (replaced) assets — but never anything that is still referenced anywhere.
 */
async function cleanupMedia({ limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - env.MEDIA_RETENTION_DAYS * 86400000);
  const candidates = await Upload.find({
    purpose: { $in: CATALOG_PURPOSES },
    $or: [
      { 'review.status': { $in: [S.REJECTED, S.PENDING_REVIEW] }, updatedAt: { $lt: cutoff } },
      { 'review.status': S.SUPERSEDED, supersededAt: { $lt: cutoff } },
    ],
  })
    .limit(limit)
    .lean();
  let removed = 0;
  for (const u of candidates) {
    if ((await findReferences(u._id)).length) continue;
    try {
      await removeUpload(u);
      await Upload.deleteOne({ _id: u._id });
      removed++;
    } catch (err) {
      logger.warn({ err: err.message, id: String(u._id) }, 'media cleanup failed; will retry');
    }
  }
  if (removed) logger.info({ removed }, 'cleaned up abandoned media');
  return { checked: candidates.length, removed };
}

/** Lets open admin panels refresh their review queue counts. */
function notifyStaff() {
  try {
    const { emitToStaff } = require('../../sockets/emitter');
    const { PERMISSIONS } = require('../../constants/roles');
    emitToStaff(PERMISSIONS.MEDIA_REVIEW, 'admin:media', { at: new Date().toISOString() });
    emitToStaff(PERMISSIONS.CATALOG_READ, 'admin:media', { at: new Date().toISOString() });
  } catch {
    /* sockets are optional */
  }
}

module.exports = {
  registerUnsplashImage,
  creditFor,
  looksLikeVideo,
  processImage,
  processVideo,
  removeUpload,
  previewUrls,
  readPreview,
  toDto,
  toRef,
  adminDto,
  findReferences,
  approve,
  reject,
  bulkReview,
  supersedeRejected,
  propagateApproval,
  resolveApprovedImage,
  resolveGallery,
  resolveVideos,
  isAllowedExternal,
  isPublicSafeUrl,
  cleanupMedia,
  notifyStaff,
  sizeKeys,
};
