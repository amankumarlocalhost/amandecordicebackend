'use strict';

const { z } = require('zod');
const analytics = require('../analytics/analytics.service');
const Product = require('../products/product.model');
const Category = require('../categories/category.model');
const ReturnRequest = require('../returns/return.model');
const { Inventory } = require('../inventory/inventory.models');
const { Coupon, Campaign, Promotion } = require('../promotions/promotion.models');
const inventoryService = require('../inventory/inventory.service');
const productService = require('../products/product.service');
const promotionService = require('../promotions/promotion.service');
const chatService = require('../chat/chat.service');
const audit = require('../audit/audit');
const { createProposal } = require('./agent');
const { formatINR } = require('../../utils/money');
const { escapeRegex, slugify } = require('../../utils/common');
const { zonedToUtc } = require('../../utils/time');
const { PERMISSIONS: P } = require('../../constants/roles');
const { MATERIALS } = require('../../constants/statuses');

const inr = (p) => (typeof p === 'number' ? formatINR(p) : p);
const toPaise = (rupees) => (rupees === undefined ? undefined : Math.round(rupees * 100));
const PERIODS = ['today', 'yesterday', 'last_7_days', 'this_week', 'last_30_days', 'this_month', 'last_month', 'last_90_days'];
const period = z.enum(PERIODS).default('last_30_days');
const IST = 5.5 * 3600000;

function periodRange(p) {
  const now = Date.now();
  const dayStart = (t) => Math.floor((t + IST) / 86400000) * 86400000 - IST;
  const today = dayStart(now);
  const d = new Date(now + IST);
  switch (p) {
    case 'today':
      return { from: new Date(today), to: new Date(now) };
    case 'yesterday':
      return { from: new Date(today - 86400000), to: new Date(today - 1) };
    case 'last_7_days':
      return { from: new Date(today - 6 * 86400000), to: new Date(now) };
    case 'this_week':
      return { from: new Date(today - ((d.getUTCDay() + 6) % 7) * 86400000), to: new Date(now) };
    case 'this_month':
      return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST), to: new Date(now) };
    case 'last_month':
      return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) - IST), to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST - 1) };
    case 'last_90_days':
      return { from: new Date(today - 89 * 86400000), to: new Date(now) };
    default:
      return { from: new Date(today - 29 * 86400000), to: new Date(now) };
  }
}

function moneyFields(obj) {
  if (Array.isArray(obj)) return obj.map(moneyFields);
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'number' && /amount|value|gov|revenue|discount|fee|tax|total|price|spent|atCost|atRetail|collected|refund/i.test(k) && !/rate|count|orders|units|share/i.test(k) ? inr(v) : moneyFields(v);
  }
  return out;
}

const propose = (ctx, artifacts, { tool, args, title, preview, requiredPermission }) =>
  createProposal({ scope: 'admin', requestedFor: ctx.userId, session: ctx.sessionId, tool, args, title, preview, requiredPermission, ttlMinutes: 120 }).then((p) => {
    artifacts.proposals.push(p);
    return { proposalId: String(p._id), status: 'awaiting_admin_confirmation', title, preview, note: 'Nothing has changed yet. An administrator with the required permission must confirm.' };
  });

const tools = [
  {
    name: 'searchCatalog',
    permission: P.CATALOG_READ,
    description: 'Find products by name, SKU or brand; returns status, prices and live stock per SKU.',
    schema: z.object({ query: z.string().min(1).max(80), status: z.enum(['draft', 'active', 'inactive', 'archived']).optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
    async handler(ctx, { query, status, limit }) {
      const rx = new RegExp(escapeRegex(query), 'i');
      const products = await Product.find({ $or: [{ name: rx }, { 'variants.sku': rx }, { brand: rx }], ...(status ? { status } : {}) }).limit(limit).select('name slug status type variants.sku variants.price variants.mrp variants.costPrice').lean();
      const avail = await inventoryService.getAvailability(products.flatMap((p) => p.variants.map((v) => v.sku)));
      const showCost = ctx.permissions.includes(P.CATALOG_COST);
      return { products: products.map((p) => ({ name: p.name, slug: p.slug, status: p.status, type: p.type, variants: p.variants.map((v) => ({ sku: v.sku, price: inr(v.price), mrp: inr(v.mrp), ...(showCost && v.costPrice ? { cost: inr(v.costPrice) } : {}), available: avail[v.sku] })) })) };
    },
  },
  {
    name: 'getProductForCopywriting',
    permission: P.CATALOG_READ,
    description: 'Verified attributes of a product to base descriptions/SEO copy on. Use only these facts in drafts.',
    schema: z.object({ slug: z.string().max(140) }).strict(),
    async handler(ctx, { slug }) {
      const p = await Product.findOne({ slug }).select('name brand description highlights specs care manufacturer isFragile giftWrapAvailable seo tags').lean();
      if (!p) return { error: 'not_found' };
      return { ...p, description: p.description?.slice(0, 1500), _id: undefined };
    },
  },
  { name: 'getLowStock', permission: P.INVENTORY_READ, description: 'SKUs at or below their low-stock threshold.', schema: z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict(), handler: (ctx, a) => analytics.lowStock(a).then((items) => ({ items })) },
  {
    name: 'getReplenishmentSuggestions',
    permission: P.INVENTORY_READ,
    description: 'SKUs likely to run out within the supplier lead time, with suggested reorder quantities (from 30-day sales velocity).',
    schema: z.object({ leadTimeDays: z.number().int().min(1).max(120).default(14) }).strict(),
    handler: (ctx, a) => analytics.replenishment(a).then((items) => ({ items })),
  },
  {
    name: 'getSkuInventory',
    permission: P.INVENTORY_READ,
    description: 'Stock buckets for one SKU (on hand, reserved, available, quarantine, damaged).',
    schema: z.object({ sku: z.string().trim().toUpperCase().max(64) }).strict(),
    async handler(ctx, { sku }) {
      const inv = await Inventory.findOne({ sku }).lean();
      if (!inv) return { error: 'not_found' };
      return { sku, onHand: inv.onHand, reserved: inv.reserved, available: inv.onHand - inv.reserved, quarantine: inv.quarantine, damaged: inv.damaged, unusable: inv.unusable, lowStockThreshold: inv.lowStockThreshold };
    },
  },
  {
    name: 'getSalesSummary',
    permission: P.REPORTS_SALES,
    description: 'Orders, gross order value, cancellations, discounts, collected revenue (UPI captured + COD collected), refunds, AOV and payment mix for a period. Unpaid COD is not revenue.',
    schema: z.object({ period, granularity: z.enum(['day', 'week', 'month']).default('day') }).strict(),
    async handler(ctx, { period: p, granularity }) {
      const r = await analytics.salesSummary({ ...periodRange(p), granularity });
      return moneyFields({ period: p, ...r, series: r.series.slice(-31) });
    },
  },
  {
    name: 'getBestsellers',
    permission: P.REPORTS_SALES,
    description: 'Top-selling products for a period, optionally within a category (e.g. "glassware").',
    schema: z.object({ period, category: z.string().max(80).optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
    handler: (ctx, { period: p, category, limit }) => analytics.bestsellers({ ...periodRange(p), category, limit }).then((items) => moneyFields({ items })),
  },
  { name: 'getOrdersAwaitingDispatch', permission: P.ORDERS_READ, description: 'Confirmed/processing/packed orders not yet shipped, with the oldest.', schema: z.object({}).strict(), handler: () => analytics.ordersAwaitingDispatch().then(moneyFields) },
  {
    name: 'getReturnsNeedingReview',
    permission: P.RETURNS_READ,
    description: 'Return/replacement requests awaiting manual review, with why they were not auto-approved.',
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
    async handler(ctx, { limit }) {
      const items = await ReturnRequest.find({ status: 'awaiting_review' }).sort({ createdAt: 1 }).limit(limit).select('requestNumber orderNumber type reason claimValue reviewReasons riskFlags createdAt items.name items.quantity').lean();
      return { count: await ReturnRequest.countDocuments({ status: 'awaiting_review' }), items: items.map((r) => ({ ...r, _id: undefined, claimValue: inr(r.claimValue) })) };
    },
  },
  { name: 'getReturnAnalytics', permission: P.RETURNS_READ, description: 'Claims by status, reason, type, source and AI involvement.', schema: z.object({ period }).strict(), handler: (ctx, { period: p }) => analytics.returnsSummary(periodRange(p)).then(moneyFields) },
  { name: 'getDamageClaimsBySku', permission: P.RETURNS_READ, description: 'SKUs with the most damage claims relative to units sold (packaging/quality signal).', schema: z.object({ period: period.default('last_90_days') }).strict(), handler: (ctx, { period: p }) => analytics.claimsBySku({ ...periodRange(p), damageOnly: true }).then((items) => ({ items })) },
  { name: 'getCancellationRates', permission: P.REPORTS_SALES, description: 'Products with the highest order cancellation rates.', schema: z.object({ period, minOrders: z.number().int().min(1).default(3) }).strict(), handler: (ctx, { period: p, minOrders }) => analytics.cancellationRates({ ...periodRange(p), minOrders }).then((items) => ({ items })) },
  { name: 'getCampaignsEnding', permission: P.PROMOTIONS_READ, description: 'Campaigns, promotions and coupons ending within N hours.', schema: z.object({ withinHours: z.number().int().min(1).max(720).default(48) }).strict(), handler: (ctx, a) => analytics.campaignsEnding(a) },
  { name: 'getCouponPerformance', permission: P.PROMOTIONS_READ, description: 'Coupon redemptions, discount cost, revenue, and live coupons with little or no use.', schema: z.object({ period }).strict(), handler: (ctx, { period: p }) => analytics.couponPerformance(periodRange(p)).then(moneyFields) },
  { name: 'getSupportSummary', permission: P.SUPPORT_READ, description: 'Support conversations, tickets and AI automation rate.', schema: z.object({ period }).strict(), handler: (ctx, { period: p }) => analytics.supportSummary(periodRange(p)) },
  { name: 'getCodSummary', permission: P.REPORTS_FINANCIAL, description: 'COD outstanding, collected and unsettled amounts.', schema: z.object({ period }).strict(), handler: (ctx, { period: p }) => analytics.codSummary(periodRange(p)).then(moneyFields) },

  // ------------------------------------------------------------ proposals (never executed by the model)
  {
    name: 'proposeCoupon',
    permission: P.PROMOTIONS_WRITE,
    description: 'Prepare a coupon for admin confirmation. Percentages are whole percent; money in rupees; dates YYYY-MM-DD or YYYY-MM-DDTHH:mm in IST.',
    schema: z
      .object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
        description: z.string().max(300),
        discountType: z.enum(['percentage', 'fixed', 'free_shipping']),
        percent: z.number().min(1).max(90).optional(),
        amountInr: z.number().min(1).max(100000).optional(),
        maxDiscountInr: z.number().min(1).max(100000).optional(),
        minCartValueInr: z.number().min(0).max(1000000).default(0),
        startsAt: z.string().max(25),
        endsAt: z.string().max(25),
        usageLimit: z.number().int().min(1).max(1000000).optional(),
        perCustomerLimit: z.number().int().min(1).max(20).default(1),
        firstOrderOnly: z.boolean().default(false),
        isPublic: z.boolean().default(false),
        activate: z.boolean().default(false),
      })
      .strict(),
    async handler(ctx, a, artifacts) {
      if (a.discountType === 'percentage' && !a.percent) return { error: 'percent_required' };
      if (a.discountType === 'fixed' && !a.amountInr) return { error: 'amountInr_required' };
      if (await Coupon.exists({ code: a.code })) return { error: 'code_exists' };
      const args = {
        code: a.code,
        description: a.description,
        discountType: a.discountType,
        value: a.discountType === 'percentage' ? Math.round(a.percent * 100) : a.discountType === 'fixed' ? toPaise(a.amountInr) : 0,
        maxDiscount: toPaise(a.maxDiscountInr),
        minCartValue: toPaise(a.minCartValueInr),
        startsAt: zonedToUtc(a.startsAt, 'Asia/Kolkata'),
        endsAt: zonedToUtc(a.endsAt, 'Asia/Kolkata'),
        timezone: 'Asia/Kolkata',
        usageLimit: a.usageLimit,
        perCustomerLimit: a.perCustomerLimit,
        firstOrderOnly: a.firstOrderOnly,
        isPublic: a.isPublic,
        isActive: a.activate,
      };
      if (Number.isNaN(args.startsAt.getTime()) || Number.isNaN(args.endsAt.getTime()) || args.endsAt <= args.startsAt) return { error: 'invalid_dates' };
      return propose(ctx, artifacts, { tool: 'proposeCoupon', args, title: `Create coupon ${a.code}${a.activate ? ' (active)' : ' (inactive)'}`, preview: { ...a }, requiredPermission: P.PROMOTIONS_WRITE });
    },
  },
  {
    name: 'proposePriceChange',
    permission: P.PRICING_WRITE,
    description: 'Prepare a selling-price (and optional MRP) change for one SKU, for admin confirmation.',
    schema: z.object({ sku: z.string().trim().toUpperCase().max(64), newPriceInr: z.number().min(1).max(1000000), newMrpInr: z.number().min(1).max(1000000).optional(), reason: z.string().min(3).max(300) }).strict(),
    async handler(ctx, a, artifacts) {
      const p = await Product.findOne({ 'variants.sku': a.sku }).select('name variants').lean();
      if (!p) return { error: 'sku_not_found' };
      const v = p.variants.find((x) => x.sku === a.sku);
      const price = toPaise(a.newPriceInr);
      const mrp = toPaise(a.newMrpInr) ?? v.mrp;
      if (price > mrp) return { error: 'price_above_mrp', mrp: inr(mrp) };
      const changePct = Math.round(((price - v.price) / v.price) * 1000) / 10;
      return propose(ctx, artifacts, { tool: 'proposePriceChange', args: { productId: String(p._id), sku: a.sku, price, mrp, reason: a.reason }, title: `Change price of ${a.sku}`, preview: { product: p.name, sku: a.sku, from: inr(v.price), to: inr(price), mrp: inr(mrp), changePercent: changePct, reason: a.reason }, requiredPermission: P.PRICING_WRITE });
    },
  },
  {
    name: 'proposeStockAdjustment',
    permission: P.INVENTORY_WRITE,
    description: 'Prepare a manual stock adjustment (+/- units) with a reason, for admin confirmation.',
    schema: z.object({ sku: z.string().trim().toUpperCase().max(64), delta: z.number().int().min(-10000).max(10000).refine((v) => v !== 0), reason: z.string().min(3).max(300) }).strict(),
    async handler(ctx, a, artifacts) {
      const inv = await Inventory.findOne({ sku: a.sku }).lean();
      if (!inv) return { error: 'sku_not_found' };
      if (a.delta < 0 && inv.onHand + a.delta < inv.reserved) return { error: 'below_reserved', onHand: inv.onHand, reserved: inv.reserved };
      return propose(ctx, artifacts, { tool: 'proposeStockAdjustment', args: a, title: `Adjust stock ${a.sku} by ${a.delta > 0 ? '+' : ''}${a.delta}`, preview: { sku: a.sku, onHand: inv.onHand, after: inv.onHand + a.delta, reason: a.reason }, requiredPermission: P.INVENTORY_WRITE });
    },
  },
  {
    name: 'proposeFestivalCampaign',
    permission: P.PROMOTIONS_WRITE,
    description: 'Prepare a festival/seasonal campaign with one automatic percentage promotion over chosen categories (slugs). Dates in IST.',
    schema: z
      .object({
        name: z.string().min(3).max(100),
        festival: z.string().max(40).optional(),
        description: z.string().max(500).optional(),
        startsAt: z.string().max(25),
        endsAt: z.string().max(25),
        percent: z.number().min(1).max(70),
        maxDiscountInr: z.number().min(1).max(100000).optional(),
        minCartValueInr: z.number().min(0).max(1000000).default(0),
        categorySlugs: z.array(z.string().max(80)).max(20).default([]),
        activate: z.boolean().default(false),
      })
      .strict(),
    async handler(ctx, a, artifacts) {
      const cats = a.categorySlugs.length ? await Category.find({ slug: { $in: a.categorySlugs } }).select('_id slug').lean() : [];
      if (cats.length !== a.categorySlugs.length) return { error: 'unknown_category', found: cats.map((c) => c.slug) };
      const startsAt = zonedToUtc(a.startsAt, 'Asia/Kolkata');
      const endsAt = zonedToUtc(a.endsAt, 'Asia/Kolkata');
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return { error: 'invalid_dates' };
      const args = { name: a.name, festival: a.festival, description: a.description, startsAt, endsAt, value: Math.round(a.percent * 100), maxDiscount: toPaise(a.maxDiscountInr), minCartValue: toPaise(a.minCartValueInr), categories: cats.map((c) => String(c._id)), activate: a.activate };
      return propose(ctx, artifacts, { tool: 'proposeFestivalCampaign', args, title: `Create campaign "${a.name}"`, preview: a, requiredPermission: P.PROMOTIONS_WRITE });
    },
  },
  {
    name: 'proposeProductDraft',
    permission: P.CATALOG_WRITE,
    description: 'Prepare a DRAFT product listing (never published automatically). Use only facts the admin supplied; leave unknown safety attributes out.',
    schema: z
      .object({
        name: z.string().min(3).max(160),
        categorySlug: z.string().max(80),
        sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,64}$/),
        priceInr: z.number().min(1).max(1000000),
        mrpInr: z.number().min(1).max(1000000),
        description: z.string().max(5000),
        highlights: z.array(z.string().max(200)).max(8).default([]),
        material: z.enum(MATERIALS).optional(),
        piecesPerSet: z.number().int().min(1).max(200).optional(),
        capacityMl: z.number().min(0).max(100000).optional(),
        seoTitle: z.string().max(70).optional(),
        seoDescription: z.string().max(170).optional(),
      })
      .strict(),
    async handler(ctx, a, artifacts) {
      const cat = await Category.findOne({ slug: a.categorySlug }).select('_id').lean();
      if (!cat) return { error: 'unknown_category' };
      if (await Product.exists({ 'variants.sku': a.sku })) return { error: 'sku_exists' };
      if (a.priceInr > a.mrpInr) return { error: 'price_above_mrp' };
      const args = {
        name: a.name,
        category: String(cat._id),
        description: a.description,
        highlights: a.highlights,
        specs: { material: a.material, piecesPerSet: a.piecesPerSet, capacityMl: a.capacityMl },
        seo: { title: a.seoTitle, description: a.seoDescription },
        variants: [{ sku: a.sku, price: toPaise(a.priceInr), mrp: toPaise(a.mrpInr), isDefault: true }],
        status: 'draft',
      };
      return propose(ctx, artifacts, { tool: 'proposeProductDraft', args, title: `Create draft product "${a.name}"`, preview: { ...a, price: inr(toPaise(a.priceInr)), mrp: inr(toPaise(a.mrpInr)) }, requiredPermission: P.CATALOG_WRITE });
    },
  },
  {
    name: 'proposeSupportReply',
    permission: P.SUPPORT_WRITE,
    description: 'Prepare a reply to a customer support conversation for the agent to approve and send.',
    schema: z.object({ conversationId: z.string().regex(/^[a-f0-9]{24}$/), message: z.string().min(2).max(1500) }).strict(),
    handler: (ctx, a, artifacts) => propose(ctx, artifacts, { tool: 'proposeSupportReply', args: a, title: 'Send support reply', preview: a, requiredPermission: P.SUPPORT_WRITE }),
  },
];

/** Executors run with the *confirming* admin's request (permissions and audit attribution). */
const executors = {
  async proposeCoupon(p, req) {
    const c = await Coupon.create({ ...p.args, createdBy: req.auth.userId });
    await promotionService.invalidate();
    await audit.record({ req, action: 'coupon.create', resource: { type: 'coupon', id: c._id }, metadata: { via: 'ai_proposal', proposal: p._id } });
    return { couponId: String(c._id), code: c.code, isActive: c.isActive };
  },
  async proposePriceChange(p, req) {
    const product = await Product.findById(p.args.productId).lean();
    const variants = product.variants.map((v) => (v.sku === p.args.sku ? { ...v, _id: String(v._id), price: p.args.price, mrp: p.args.mrp } : { ...v, _id: String(v._id) }));
    await productService.updateProduct(p.args.productId, { variants: variants.map(({ costPrice, ...v }) => v) }, req);
    return { sku: p.args.sku, price: inr(p.args.price), mrp: inr(p.args.mrp) };
  },
  async proposeStockAdjustment(p, req) {
    const doc = await inventoryService.adjust(p.args.sku, p.args.delta, `${p.args.reason} (AI proposal ${p._id})`, { type: 'staff', id: req.auth.userId });
    await audit.record({ req, action: 'inventory.adjust', resource: { type: 'sku', id: p.args.sku }, metadata: { delta: p.args.delta, via: 'ai_proposal' } });
    return { sku: doc.sku, onHand: doc.onHand, available: doc.onHand - doc.reserved };
  },
  async proposeFestivalCampaign(p, req) {
    const a = p.args;
    const campaign = await Campaign.create({ name: a.name, slug: `${slugify(a.name)}-${Date.now().toString(36)}`, festival: a.festival, description: a.description, startsAt: a.startsAt, endsAt: a.endsAt, isActive: a.activate, createdBy: req.auth.userId });
    const promo = await Promotion.create({
      name: a.name,
      campaign: campaign._id,
      discountType: 'percentage',
      value: a.value,
      maxDiscount: a.maxDiscount,
      minCartValue: a.minCartValue || 0,
      scope: a.categories.length ? { appliesTo: 'categories', categories: a.categories } : { appliesTo: 'all' },
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      isActive: a.activate,
      badge: a.festival ? `${a.festival} offer` : 'Sale',
      createdBy: req.auth.userId,
    });
    await promotionService.invalidate();
    await audit.record({ req, action: 'campaign.create', resource: { type: 'campaign', id: campaign._id }, metadata: { via: 'ai_proposal', promotion: promo._id } });
    return { campaignId: String(campaign._id), promotionId: String(promo._id), active: a.activate };
  },
  async proposeProductDraft(p, req) {
    const product = await productService.createProduct({ ...p.args, status: 'draft' }, req);
    return { productId: String(product._id), slug: product.slug, status: product.status };
  },
  async proposeSupportReply(p, req) {
    const { message } = await chatService.postMessage(req.auth, p.args.conversationId, { body: p.args.message, clientMessageId: `aiprop-${p._id}` });
    return { messageId: String(message.id) };
  },
};

module.exports = { tools, executors, periodRange };
