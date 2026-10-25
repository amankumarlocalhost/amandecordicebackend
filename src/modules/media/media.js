'use strict';

const multer = require('multer');
const { z } = require('zod');
const env = require('../../config/env');
const service = require('./media.service');
const { Upload, CATALOG_PURPOSES } = require('./media.model');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { created, ok } = require('../../utils/response');
const { AppError, badRequest, notFound, conflict, forbidden } = require('../../utils/errors');
const { limits } = require('../../middleware/rateLimit');
const { objectId, paginationSchema, pageMeta, escapeRegex } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { MEDIA_STATUS } = require('../../constants/statuses');

const IMAGE_MAX_BYTES = { customer: 8 * 1024 * 1024, admin: 15 * 1024 * 1024 };
const IMAGE_MIME = /^image\/(jpeg|png|webp|heic|heif|avif)$/;
const VIDEO_MIME = /^video\/(mp4|quicktime|webm)$/;

function multerFor({ maxFiles, imageMaxBytes, allowVideo }) {
  const videoBytes = env.MEDIA_MAX_VIDEO_MB * 1024 * 1024;
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: allowVideo ? Math.max(imageMaxBytes, videoBytes) : imageMaxBytes, files: maxFiles, fields: 5 },
    fileFilter: (req, file, cb) => {
      if (IMAGE_MIME.test(file.mimetype)) return cb(null, true);
      if (allowVideo && VIDEO_MIME.test(file.mimetype)) return cb(null, true);
      cb(badRequest(allowVideo ? 'Only JPEG/PNG/WebP/HEIC/AVIF images or MP4/MOV/WebM videos are allowed' : 'Only JPEG, PNG, WebP, HEIC or AVIF images are allowed'));
    },
  }).array('files', maxFiles);
}

/** Ensures every referenced upload exists, belongs to the user and has an expected purpose. */
async function resolveOwnedUploads(ids, ownerId, purpose) {
  if (!ids?.length) return [];
  const docs = await Upload.find({ _id: { $in: ids }, owner: ownerId, purpose: { $in: [].concat(purpose) } }).lean();
  if (docs.length !== new Set(ids.map(String)).size) throw badRequest('One or more attachments are invalid');
  return docs;
}

const api = createRouter({ prefix: '/api/v1', tag: 'Media' });

// ------------------------------------------------------------------ customer uploads (unchanged: evidence, chat, reviews)

api.post(
  '/uploads',
  {
    summary: 'Upload customer images or videos (return evidence, chat attachments, review media). Max 5 files; images 8 MB, videos MEDIA_MAX_VIDEO_MB / MEDIA_MAX_VIDEO_SECONDS (Cloudinary only).',
    customer: true,
    rateLimit: limits.upload,
    upload: multerFor({ maxFiles: 5, imageMaxBytes: IMAGE_MAX_BYTES.customer, allowVideo: true }),
    query: z.object({ purpose: z.enum(['return', 'chat', 'review']) }),
  },
  async (req, res) => {
    if (!req.files?.length) throw badRequest('No files uploaded (field name: files)');
    const docs = [];
    for (const f of req.files) {
      const opts = { purpose: req.query.purpose, ownerId: req.auth.userId, originalName: f.originalname };
      if (VIDEO_MIME.test(f.mimetype)) docs.push(await service.processVideo(f.buffer, opts));
      else {
        if (f.size > IMAGE_MAX_BYTES.customer) throw badRequest(`Images can be at most ${IMAGE_MAX_BYTES.customer / 1048576} MB`);
        docs.push(await service.processImage(f.buffer, opts));
      }
    }
    created(res, docs.map(service.toDto), 'Uploaded');
  },
);

// ------------------------------------------------------------------ catalog media (review workflow)

const PURPOSE_PERMISSION = {
  product: [PERMISSIONS.CATALOG_WRITE],
  category: [PERMISSIONS.CATALOG_WRITE],
  collection: [PERMISSIONS.CATALOG_WRITE],
  banner: [PERMISSIONS.PROMOTIONS_WRITE, PERMISSIONS.CONTENT_WRITE],
  content: [PERMISSIONS.CONTENT_WRITE],
};
const TARGET_FOR = { product: 'product', category: 'category', collection: 'collection', banner: 'campaign', content: 'content' };

async function validateTarget(type, id) {
  if (!id) return undefined;
  const models = {
    product: () => require('../products/product.model'),
    category: () => require('../categories/category.model'),
    collection: () => require('../collections/collection.model'),
    campaign: () => require('../promotions/promotion.models').Campaign,
  };
  if (type === 'content') {
    if (!/^[a-z0-9:_-]{2,80}$/.test(id)) throw badRequest('Invalid content target');
    return { type, id };
  }
  if (!/^[a-f0-9]{24}$/.test(id) || !(await models[type]().exists({ _id: id }))) throw badRequest(`Target ${type} not found`);
  return { type, id };
}

api.post(
  '/admin/media',
  {
    summary:
      'Upload storefront media. Files are validated by decoding (not by MIME type), stripped of EXIF, re-encoded and stored PRIVATELY with status pending_review; ' +
      'they get public URLs only after approval. Max 10 files; images 15 MB (min MEDIA_MIN_DIMENSION px), videos via Cloudinary. ' +
      'Optional targetId links the upload to the record it is meant for; replaces=<uploadId> uploads a replacement (for a product image: staged until published).',
    permission: [PERMISSIONS.CATALOG_WRITE, PERMISSIONS.CONTENT_WRITE, PERMISSIONS.PROMOTIONS_WRITE],
    rateLimit: limits.upload,
    upload: multerFor({ maxFiles: 10, imageMaxBytes: IMAGE_MAX_BYTES.admin, allowVideo: true }),
    query: z.object({ purpose: z.enum(CATALOG_PURPOSES).default('product'), targetId: z.string().trim().max(80).optional(), replaces: objectId().optional() }),
  },
  async (req, res) => {
    const { purpose, targetId, replaces } = req.query;
    if (!PURPOSE_PERMISSION[purpose].some((p) => req.auth.permissions.includes(p))) throw forbidden(`You cannot upload ${purpose} media`);
    if (!req.files?.length) throw badRequest('No files uploaded (field name: files)');
    const target = await validateTarget(TARGET_FOR[purpose], targetId);
    let replaced = null;
    if (replaces) {
      if (req.files.length !== 1) throw badRequest('Upload exactly one file as a replacement');
      replaced = await Upload.findOne({ _id: replaces, purpose: { $in: CATALOG_PURPOSES } });
      if (!replaced) throw badRequest('The media being replaced was not found');
    }

    const docs = [];
    const failed = [];
    for (const f of req.files) {
      try {
        const opts = { purpose, ownerId: req.auth.userId, review: true, originalName: f.originalname, target, replaces: replaced?._id };
        if (VIDEO_MIME.test(f.mimetype)) docs.push(await service.processVideo(f.buffer, opts));
        else {
          if (f.size > IMAGE_MAX_BYTES.admin) throw new AppError(413, 'FILE_TOO_LARGE', `Images can be at most ${IMAGE_MAX_BYTES.admin / 1048576} MB`);
          docs.push(await service.processImage(f.buffer, { ...opts, minDimension: env.MEDIA_MIN_DIMENSION }));
        }
      } catch (err) {
        if (!err.expose) throw err;
        failed.push({ name: f.originalname?.slice(0, 150), status: err.status, code: err.code, message: err.message });
      }
    }
    if (!docs.length) throw new AppError(failed[0]?.status || 400, failed[0]?.code || 'UPLOAD_FAILED', failed[0]?.message || 'Upload failed', failed);

    if (replaced) {
      const fresh = docs[0];
      if (replaced.review?.status === MEDIA_STATUS.REJECTED || replaced.review?.status === MEDIA_STATUS.PENDING_REVIEW) {
        await service.supersedeRejected(replaced, fresh, req);
      } else if (target?.type === 'product') {
        // Live image replacement: the current image stays on the storefront until the new one is approved AND published.
        await require('../products/product.service').stageReplacement(target.id, replaced._id, fresh._id, req);
      }
    }
    for (const d of docs) await audit.record({ req, action: 'media.upload', resource: { type: 'media', id: d._id }, metadata: { purpose, target, replaces: replaced?._id, name: d.originalName } });
    service.notifyStaff();
    res.status(201).json({ success: true, message: `${docs.length} file(s) uploaded and sent for review`, data: docs.map((d) => service.adminDto(d.toObject())), ...(failed.length ? { meta: { failed } } : {}) });
  },
);

const listQuery = paginationSchema.extend({
  status: z.enum([...Object.values(MEDIA_STATUS), 'all']).default('all'),
  purpose: z.enum(CATALOG_PURPOSES).optional(),
  kind: z.enum(['image', 'video']).optional(),
  uploader: objectId().optional(),
  targetType: z.enum(['product', 'category', 'collection', 'campaign', 'content']).optional(),
  targetId: z.string().max(80).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

api.get('/admin/media', { summary: 'Media library and review queue (filters: status, purpose, uploader, target)', permission: [PERMISSIONS.CATALOG_READ, PERMISSIONS.MEDIA_REVIEW, PERMISSIONS.CONTENT_WRITE], query: listQuery }, async (req, res) => {
  const q = req.query;
  const filter = { purpose: q.purpose || { $in: CATALOG_PURPOSES } };
  if (q.status !== 'all') filter['review.status'] = q.status;
  if (q.kind) filter.kind = q.kind;
  if (q.uploader) filter.owner = q.uploader;
  if (q.targetType) filter['target.type'] = q.targetType;
  if (q.targetId) filter['target.id'] = q.targetId;
  if (q.q) filter.originalName = new RegExp(escapeRegex(q.q), 'i');
  const [items, total] = await Promise.all([
    Upload.find(filter)
      .sort({ createdAt: q.sort === 'oldest' ? 1 : -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .select('-history')
      .populate('owner', 'name')
      .lean(),
    Upload.countDocuments(filter),
  ]);
  ok(res, items.map(service.adminDto), { meta: pageMeta(q.page, q.limit, total) });
});

api.get('/admin/media/stats', { summary: 'Media counts by review status', permission: [PERMISSIONS.CATALOG_READ, PERMISSIONS.MEDIA_REVIEW, PERMISSIONS.CONTENT_WRITE] }, async (req, res) => {
  const rows = await Upload.aggregate([{ $match: { purpose: { $in: CATALOG_PURPOSES } } }, { $group: { _id: '$review.status', n: { $sum: 1 } } }]);
  ok(res, Object.fromEntries(Object.values(MEDIA_STATUS).map((s) => [s, rows.find((r) => r._id === s)?.n || 0])));
});

const idParam = z.object({ id: objectId() });

api.get('/admin/media/:id', { summary: 'Media detail with review history and where it is used', permission: [PERMISSIONS.CATALOG_READ, PERMISSIONS.MEDIA_REVIEW, PERMISSIONS.CONTENT_WRITE], params: idParam }, async (req, res) => {
  const u = await Upload.findOne({ _id: req.params.id, purpose: { $in: CATALOG_PURPOSES } })
    .populate('owner', 'name')
    .populate('review.reviewedBy', 'name')
    .populate('history.by', 'name')
    .lean();
  if (!u) throw notFound('Media');
  const references = await service.findReferences(u._id);
  ok(res, { ...service.adminDto(u), reviewedBy: u.review?.reviewedBy?.name ? { id: u.review.reviewedBy._id, name: u.review.reviewedBy.name } : null, references });
});

api.post('/admin/media/:id/approve', { summary: 'Approve media: it moves to public storage and becomes usable on published records', permission: PERMISSIONS.MEDIA_REVIEW, params: idParam, body: z.object({ note: z.string().max(300).optional() }) }, async (req, res) => {
  const u = await service.approve(req.params.id, req);
  ok(res, service.adminDto(u.toObject()), { message: 'Media approved' });
});

api.post(
  '/admin/media/:id/reject',
  { summary: 'Reject media with a reason (stays private); optionally request a replacement upload', permission: PERMISSIONS.MEDIA_REVIEW, params: idParam, body: z.object({ reason: z.string().trim().min(3).max(500), requestReplacement: z.boolean().default(false) }) },
  async (req, res) => {
    const u = await service.reject(req.params.id, req.body, req);
    ok(res, service.adminDto(u.toObject()), { message: req.body.requestReplacement ? 'Replacement requested' : 'Media rejected' });
  },
);

api.post(
  '/admin/media/review',
  {
    summary: 'Bulk approve or reject (max 50). Requires confirm: true. Each item is reported separately.',
    permission: PERMISSIONS.MEDIA_REVIEW,
    body: z
      .object({ ids: z.array(objectId()).min(1).max(50), decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(500).optional(), requestReplacement: z.boolean().default(false), confirm: z.literal(true) })
      .refine((b) => b.decision === 'approve' || b.reason, { message: 'A reason is required to reject', path: ['reason'] }),
  },
  async (req, res) => {
    const results = await service.bulkReview({ ...req.body, ids: [...new Set(req.body.ids)] }, req);
    const done = results.filter((r) => r.ok).length;
    ok(res, results, { message: `${done} of ${results.length} reviewed` });
  },
);

api.delete('/admin/media/:id', { summary: 'Delete media from storage (refused while it is used anywhere)', permission: [PERMISSIONS.CATALOG_WRITE, PERMISSIONS.CONTENT_WRITE], params: idParam }, async (req, res) => {
  const u = await Upload.findOne({ _id: req.params.id, purpose: { $in: CATALOG_PURPOSES } });
  if (!u) throw notFound('Media');
  const refs = await service.findReferences(u._id);
  if (refs.length) throw conflict(`This media is still used by ${refs.length} record(s). Remove it from them first.`, 'MEDIA_IN_USE', refs.slice(0, 10));
  await service.removeUpload(u);
  await u.deleteOne();
  await audit.record({ req, action: 'media.delete', resource: { type: 'media', id: u._id }, metadata: { name: u.originalName, status: u.review?.status } });
  service.notifyStaff();
  ok(res, null, { message: 'Media deleted' });
});

// Signed, short-lived private preview for media under review (local/S3 storage). No cookie needed,
// so <img> tags work cross-origin; the signature binds id, size and expiry.
api.get(
  '/media/preview/:id/:size',
  { summary: 'Signed private preview (links are issued by the admin media endpoints and expire)', params: z.object({ id: objectId(), size: z.enum(['thumb', 'medium', 'large']) }), query: z.object({ exp: z.string().max(12), sig: z.string().max(64) }) },
  async (req, res) => {
    const file = await service.readPreview(req.params.id, req.params.size, req.query.exp, req.query.sig);
    if (!file) throw notFound('Preview');
    res.set({ 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'X-Robots-Tag': 'noindex' });
    res.send(file.buffer);
  },
);

module.exports = {
  Upload,
  processImage: service.processImage,
  processVideo: service.processVideo,
  resolveOwnedUploads,
  removeUpload: service.removeUpload,
  looksLikeVideo: service.looksLikeVideo,
  toDto: service.toDto,
  toRef: service.toRef,
  router: api,
};
