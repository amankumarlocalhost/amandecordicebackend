'use strict';

const { z } = require('zod');
const { Campaign, Promotion, Coupon, CouponRedemption } = require('./promotion.models');
const service = require('./promotion.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, badRequest } = require('../../utils/errors');
const { objectId, paginationSchema, paginate, slugify } = require('../../utils/common');
const { zonedToUtc, isValidTimeZone } = require('../../utils/time');
const { PERMISSIONS } = require('../../constants/roles');
const media = require('../media/media.service');

const tz = z.string().default('Asia/Kolkata').refine(isValidTimeZone, 'Invalid IANA time zone');
const when = z.union([z.string().min(10).max(40), z.date()]);

const scope = z
  .object({
    appliesTo: z.enum(['all', 'products', 'categories', 'brands', 'collections']).default('all'),
    products: z.array(objectId()).max(500).default([]),
    categories: z.array(objectId()).max(100).default([]),
    brands: z.array(z.string().trim().toLowerCase().max(80)).max(100).default([]),
    collections: z.array(objectId()).max(100).default([]),
    excludeProducts: z.array(objectId()).max(500).default([]),
  })
  .default({ appliesTo: 'all' });

const discountBase = z.object({
  discountType: z.enum(['percentage', 'fixed', 'free_shipping']),
  value: z.number().int().min(0).default(0),
  maxDiscount: z.number().int().min(1).optional(),
  scope,
  minCartValue: z.number().int().min(0).default(0),
  segment: z.enum(['all', 'new_customers', 'repeat_customers']).default('all'),
  startsAt: when,
  endsAt: when,
  timezone: tz,
  isActive: z.boolean().default(false),
  campaign: objectId().nullable().optional(),
});

function checkDiscount(d, ctx) {
  if (d.discountType === 'percentage' && (d.value < 1 || d.value > 9000)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percentage value is in basis points: 1–9000 (0.01%–90%)' });
  if (d.discountType === 'fixed' && d.value < 1) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Fixed discount must be at least 1 paisa' });
  const s = zonedToUtc(d.startsAt, d.timezone);
  const e = zonedToUtc(d.endsAt, d.timezone);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'Invalid date' });
  else if (e <= s) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
}

const promotionBase = discountBase.extend({
    name: z.string().trim().min(2).max(120),
    description: z.string().max(500).optional(),
    priority: z.number().int().min(-100).max(100).default(0),
    stackableWithCoupons: z.boolean().default(true),
    badge: z.string().max(30).optional(),
});
const promotionBody = promotionBase.superRefine(checkDiscount);

const couponBase = discountBase.extend({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
    description: z.string().max(500).optional(),
    usageLimit: z.number().int().min(1).optional(),
    perCustomerLimit: z.number().int().min(1).max(100).default(1),
    firstOrderOnly: z.boolean().default(false),
    stackableWithPromotions: z.boolean().default(false),
    paymentMethods: z.array(z.enum(['upi', 'cod'])).max(2).default([]),
    isPublic: z.boolean().default(false),
});
const couponBody = couponBase.superRefine(checkDiscount);

const campaignBase = z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).max(100).optional(),
    festival: z.string().trim().toLowerCase().max(60).optional(),
    description: z.string().max(2000).optional(),
    // Approved uploads (media ids) or allow-listed URLs only.
    banner: z
      .object({ media: objectId().optional(), url: z.string().url().optional(), mobileMedia: objectId().optional(), mobileUrl: z.string().url().optional(), alt: z.string().max(160).optional() })
      .refine((b) => b.media || b.url, 'banner needs media or url')
      .nullable()
      .optional(),
    startsAt: when,
    endsAt: when,
    timezone: tz,
    isActive: z.boolean().default(false),
});
const campaignBody = campaignBase.superRefine((d, ctx) => {
    if (zonedToUtc(d.endsAt, d.timezone) <= zonedToUtc(d.startsAt, d.timezone)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
  });

/** Banner images must be approved media; URLs are taken from the media record, not the client. */
async function resolveBanner(body, existing) {
  if (!body.banner) return body;
  const old = existing?.banner || {};
  const main = await media.resolveApprovedImage({ media: body.banner.media, url: body.banner.url, alt: body.banner.alt }, { field: 'banner', existing: old.url ? { url: old.url, media: old.media } : undefined });
  const mobile = body.banner.mobileMedia || body.banner.mobileUrl ? await media.resolveApprovedImage({ media: body.banner.mobileMedia, url: body.banner.mobileUrl }, { field: 'banner.mobile', existing: old.mobileUrl ? { url: old.mobileUrl, media: old.mobileMedia } : undefined }) : null;
  body.banner = { media: main.media, url: main.url, alt: body.banner.alt, ...(mobile ? { mobileMedia: mobile.media, mobileUrl: mobile.url } : {}) };
  return body;
}

function normaliseDates(body, existing) {
  const zone = body.timezone || existing?.timezone || 'Asia/Kolkata';
  if (body.startsAt) body.startsAt = zonedToUtc(body.startsAt, zone);
  if (body.endsAt) body.endsAt = zonedToUtc(body.endsAt, zone);
  const s = body.startsAt || existing?.startsAt;
  const e = body.endsAt || existing?.endsAt;
  if (s && e && e <= s) throw badRequest('endsAt must be after startsAt');
  return body;
}

function status(item, now = new Date()) {
  if (!item.isActive) return 'paused_or_draft';
  if (now < item.startsAt) return 'scheduled';
  if (now > item.endsAt) return 'ended';
  return 'live';
}

// ------------------------------------------------------------------ public
const pub = createRouter({ prefix: '/api/v1', tag: 'Promotions' });

pub.get('/promotions/active', { summary: 'Live campaigns and automatic offers' }, async (req, res) => {
  const promos = await service.activePromotions();
  const now = new Date();
  const campaigns = await Campaign.find({ isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } }).select('name slug festival description banner startsAt endsAt timezone').lean();
  ok(res, {
    campaigns,
    promotions: promos.map((p) => ({ id: p._id, name: p.name, description: p.description, badge: p.badge, discountType: p.discountType, value: p.value, maxDiscount: p.maxDiscount, minCartValue: p.minCartValue, endsAt: p.endsAt, scope: { appliesTo: p.scope?.appliesTo } })),
  });
});

pub.get('/coupons/available', { summary: 'Public coupons currently valid' }, async (req, res) => {
  const now = new Date();
  const coupons = await Coupon.find({ isActive: true, isPublic: true, startsAt: { $lte: now }, endsAt: { $gte: now } })
    .select('code description discountType value maxDiscount minCartValue endsAt firstOrderOnly paymentMethods usageLimit usedCount')
    .lean();
  ok(res, coupons.filter((c) => !c.usageLimit || c.usedCount < c.usageLimit).map(({ usageLimit, usedCount, ...c }) => c));
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin', tag: 'Admin: Promotions' });
const idParam = z.object({ id: objectId() });

function crud(path, Model, bodySchema, updateSchema, kind) {
  admin.get(`/${path}`, { summary: `List ${path}`, permission: PERMISSIONS.PROMOTIONS_READ, query: paginationSchema.extend({ campaign: objectId().optional() }) }, async (req, res) => {
    const { page, limit, campaign } = req.query;
    const { items, meta } = await paginate(Model, campaign ? { campaign } : {}, { page, limit });
    ok(res, items.map((i) => ({ ...i, state: status(i) })), { meta });
  });
  admin.get(`/${path}/:id`, { summary: `Get ${kind}`, permission: PERMISSIONS.PROMOTIONS_READ, params: idParam }, async (req, res) => {
    const item = await Model.findById(req.params.id).lean();
    if (!item) throw notFound(kind);
    ok(res, { ...item, state: status(item) });
  });
  admin.post(`/${path}`, { summary: `Create ${kind}`, permission: PERMISSIONS.PROMOTIONS_WRITE, body: bodySchema }, async (req, res) => {
    const data = normaliseDates({ ...req.body });
    if (kind === 'Campaign') {
      data.slug = data.slug || slugify(data.name);
      await resolveBanner(data);
      if (data.banner === null) delete data.banner;
    }
    const item = await Model.create({ ...data, createdBy: req.auth.userId });
    await audit.record({ req, action: `${kind.toLowerCase()}.create`, resource: { type: kind.toLowerCase(), id: item._id }, metadata: data });
    await service.invalidate();
    created(res, item);
  });
  admin.patch(`/${path}/:id`, { summary: `Update ${kind}`, permission: PERMISSIONS.PROMOTIONS_WRITE, params: idParam, body: updateSchema }, async (req, res) => {
    const existing = await Model.findById(req.params.id);
    if (!existing) throw notFound(kind);
    const data = normaliseDates({ ...req.body }, existing);
    if (kind === 'Campaign') {
      await resolveBanner(data, existing);
      if (data.banner === null) data.banner = undefined;
    }
    if (data.code && data.code !== existing.code && (await CouponRedemption.exists({ coupon: existing._id }))) throw badRequest('A coupon that has been used cannot be renamed');
    existing.set(data);
    if (kind !== 'Campaign') {
      const merged = existing.toObject();
      if (merged.discountType === 'percentage' && (merged.value < 1 || merged.value > 9000)) throw badRequest('Percentage value is in basis points: 1–9000');
      if (merged.discountType === 'fixed' && merged.value < 1) throw badRequest('Fixed discount must be at least 1 paisa');
    }
    await existing.save();
    await audit.record({ req, action: `${kind.toLowerCase()}.update`, resource: { type: kind.toLowerCase(), id: existing._id }, metadata: data });
    await service.invalidate();
    ok(res, existing, { message: `${kind} updated` });
  });
  admin.post(`/${path}/:id/activate`, { summary: `Activate ${kind}`, permission: PERMISSIONS.PROMOTIONS_WRITE, params: idParam }, async (req, res) => {
    const item = await Model.findByIdAndUpdate(req.params.id, { $set: { isActive: true } }, { new: true });
    if (!item) throw notFound(kind);
    await audit.record({ req, action: `${kind.toLowerCase()}.activate`, resource: { type: kind.toLowerCase(), id: item._id } });
    await service.invalidate();
    ok(res, { ...item.toObject(), state: status(item) }, { message: `${kind} activated` });
  });
  admin.post(`/${path}/:id/pause`, { summary: `Pause ${kind}`, permission: PERMISSIONS.PROMOTIONS_WRITE, params: idParam }, async (req, res) => {
    const item = await Model.findByIdAndUpdate(req.params.id, { $set: { isActive: false } }, { new: true });
    if (!item) throw notFound(kind);
    await audit.record({ req, action: `${kind.toLowerCase()}.pause`, resource: { type: kind.toLowerCase(), id: item._id } });
    await service.invalidate();
    ok(res, item, { message: `${kind} paused` });
  });
}

crud('campaigns', Campaign, campaignBody, campaignBase.partial(), 'Campaign');
crud('promotions', Promotion, promotionBody, promotionBase.partial(), 'Promotion');
crud('coupons', Coupon, couponBody, couponBase.partial(), 'Coupon');

admin.get('/coupons/:id/redemptions', { summary: 'Coupon redemptions', permission: PERMISSIONS.PROMOTIONS_READ, params: idParam, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(CouponRedemption, { coupon: req.params.id }, { ...req.query, populate: { path: 'order', select: 'orderNumber pricing.total status createdAt' } });
  ok(res, items, { meta });
});

module.exports = { routers: [pub, admin], promotionBody, couponBody, campaignBody, checkDiscount, normaliseDates };
