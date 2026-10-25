'use strict';

const { z } = require('zod');
const service = require('./content.service');
const { Page } = require('./content.models');
const { CONTENT_KEYS, SECTION_IDS, ICONS } = require('./content.schemas');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate, escapeRegex } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const env = require('../../config/env');

const keyParam = z.object({ key: z.enum(Object.keys(CONTENT_KEYS)) });
const slugParam = z.object({ slug: z.string().trim().toLowerCase().max(80) });

// ------------------------------------------------------------------ public (published only)
const pub = createRouter({ prefix: '/api/v1', tag: 'Content' });

pub.get('/content/:key', { summary: 'Published storefront content block (homepage, footer, announcement, navigation). data is null until first publish.', params: keyParam }, async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  ok(res, await service.getPublished(req.params.key));
});

pub.get('/content/:key/preview', { summary: 'Draft content for a signed preview link (issued by the admin panel)', params: keyParam, query: z.object({ token: z.string().max(600) }) }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, await service.getDraftForPreview(req.params.key, req.query.token));
});

pub.get('/pages', { summary: 'Published informational pages' }, async (req, res) => {
  ok(res, await service.listPublishedPages());
});

pub.get('/pages/:slug', { summary: 'A published informational page', params: slugParam }, async (req, res) => {
  ok(res, await service.getPublishedPage(req.params.slug));
});

pub.get('/pages/:slug/preview', { summary: 'Draft page for a signed preview link', params: slugParam, query: z.object({ token: z.string().max(600) }) }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, await service.getPageDraftForPreview(req.params.slug, req.query.token));
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin', tag: 'Admin: Content' });
const P = PERMISSIONS.CONTENT_WRITE;
const versionBody = z.object({ version: z.number().int().min(1) });

admin.get('/content', { summary: 'Content blocks with draft/published state', permission: P }, async (req, res) => {
  const blocks = await Promise.all(Object.keys(CONTENT_KEYS).map((k) => service.getBlock(k)));
  ok(res, blocks.map(({ draft, published, history, ...b }) => b), { meta: { sections: SECTION_IDS, icons: ICONS } });
});

admin.get('/content/:key', { summary: 'Content block: draft, published, versions and history', permission: P, params: keyParam }, async (req, res) => {
  ok(res, await service.getBlock(req.params.key), { meta: { sections: SECTION_IDS, icons: ICONS } });
});

admin.put(
  '/content/:key/draft',
  { summary: 'Save the draft. baseVersion must equal the draftVersion you loaded (else 409 STALE_WRITE). Images must be approved media.', permission: P, params: keyParam, body: z.object({ data: z.record(z.string(), z.any()), baseVersion: z.number().int().min(0) }) },
  async (req, res) => {
    ok(res, await service.saveDraft(req.params.key, req.body.data, req.body.baseVersion, req), { message: 'Draft saved' });
  },
);

admin.post('/content/:key/publish', { summary: 'Publish the draft version you reviewed; the storefront is revalidated and notified', permission: P, params: keyParam, body: versionBody }, async (req, res) => {
  ok(res, await service.publish(req.params.key, req.body.version, req), { message: 'Published' });
});

admin.post('/content/:key/discard', { summary: 'Discard unpublished draft changes', permission: P, params: keyParam }, async (req, res) => {
  ok(res, await service.discardDraft(req.params.key, req), { message: 'Draft discarded' });
});

admin.post('/content/:key/rollback', { summary: 'Re-publish an earlier published version', permission: P, params: keyParam, body: versionBody }, async (req, res) => {
  ok(res, await service.rollback(req.params.key, req.body.version, req), { message: 'Rolled back' });
});

admin.post('/content/:key/preview-token', { summary: 'Signed 15-minute link to preview the draft on the storefront', permission: P, params: keyParam }, async (req, res) => {
  const t = service.previewToken(`content:${req.params.key}`);
  ok(res, { ...t, path: `/preview/${req.params.key}?token=${encodeURIComponent(t.token)}`, storefront: env.frontendOrigins[0] });
});

const pageBody = z.object({
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().max(300).optional(),
  body: z.string().max(50000).optional(),
  heroImage: z.any().optional(),
  seo: z.any().optional(),
  showInFooter: z.boolean().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
});

admin.get('/pages', { summary: 'Informational pages', permission: P, query: paginationSchema.extend({ q: z.string().trim().max(80).optional(), status: z.enum(['draft', 'published', 'unpublished']).optional() }) }, async (req, res) => {
  const { page, limit, q, status } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (q) filter.$or = [{ slug: new RegExp(escapeRegex(q), 'i') }, { 'draft.title': new RegExp(escapeRegex(q), 'i') }];
  const { items, meta } = await paginate(Page, filter, { page, limit, sort: { sortOrder: 1, updatedAt: -1 }, select: '-history -draft.body -published.body', populate: { path: 'draftUpdatedBy', select: 'name' } });
  ok(res, items.map((p) => service.pageDto(p, { full: false })), { meta });
});

admin.post('/pages', { summary: 'Create a draft page', permission: P, body: pageBody.extend({ slug: z.string().trim().toLowerCase().min(2).max(80) }) }, async (req, res) => {
  created(res, await service.createPage(req.body, req));
});

admin.get('/pages/:id', { summary: 'Page with draft, published version and history', permission: P, params: z.object({ id: objectId() }) }, async (req, res) => {
  const p = await Page.findById(req.params.id).populate('draftUpdatedBy', 'name').populate('publishedBy', 'name').lean();
  if (!p) throw notFound('Page');
  ok(res, service.pageDto(p));
});

admin.put(
  '/pages/:id/draft',
  { summary: 'Save the page draft (optimistic concurrency via baseVersion)', permission: P, params: z.object({ id: objectId() }), body: pageBody.extend({ baseVersion: z.number().int().min(1), slug: z.string().trim().toLowerCase().min(2).max(80).optional() }) },
  async (req, res) => {
    ok(res, await service.savePageDraft(req.params.id, req.body, req), { message: 'Draft saved' });
  },
);

admin.post('/pages/:id/publish', { summary: 'Publish the reviewed draft version', permission: P, params: z.object({ id: objectId() }), body: versionBody }, async (req, res) => {
  ok(res, await service.publishPage(req.params.id, req.body.version, req), { message: 'Page published' });
});

admin.post('/pages/:id/unpublish', { summary: 'Take a page offline', permission: P, params: z.object({ id: objectId() }) }, async (req, res) => {
  ok(res, await service.unpublishPage(req.params.id, req), { message: 'Page unpublished' });
});

admin.post('/pages/:id/preview-token', { summary: 'Signed link to preview the page draft', permission: P, params: z.object({ id: objectId() }) }, async (req, res) => {
  const p = await Page.findById(req.params.id).select('slug').lean();
  if (!p) throw notFound('Page');
  const t = service.previewToken(`page:${p.slug}`);
  ok(res, { ...t, path: `/preview/page/${p.slug}?token=${encodeURIComponent(t.token)}`, storefront: env.frontendOrigins[0] });
});

admin.delete('/pages/:id', { summary: 'Delete an unpublished page', permission: P, params: z.object({ id: objectId() }) }, async (req, res) => {
  await service.deletePage(req.params.id, req);
  ok(res, null, { message: 'Page deleted' });
});

module.exports = { routers: [pub, admin] };
