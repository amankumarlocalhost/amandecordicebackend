'use strict';

const { z } = require('zod');
const Order = require('../orders/order.model');
const Category = require('../categories/category.model');
const { Shipment } = require('../shipping/shipping.models');
const { ChatMessage } = require('../chat/chat.models');
const productService = require('../products/product.service');
const promotionService = require('../promotions/promotion.service');
const shippingService = require('../shipping/shipping.service');
const returnService = require('../returns/return.service');
const orderService = require('../orders/order.service');
const chatService = require('../chat/chat.service');
const cache = require('../../services/cache');
const { getSettings } = require('../settings/settings');
const { createProposal } = require('./agent');
const { formatINR } = require('../../utils/money');
const { escapeRegex } = require('../../utils/common');
const { RETURN_REASONS, CUSTOMER_CANCELLABLE, MATERIALS } = require('../../constants/statuses');

/**
 * Customer assistant tools. Identity always comes from ctx.userId (the authenticated session);
 * no tool accepts a user id, and order tools only ever query `{ user: ctx.userId }`.
 * Outputs are minimised: no addresses, phone numbers, emails, cost prices or other customers' data.
 */

const inr = (paise) => (typeof paise === 'number' ? formatINR(paise) : undefined);
const orderNumber = z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}-\d{6}-[A-Z0-9]{6}$/, 'Order numbers look like CRK-261023-ABC123');
const untrusted = (s, n = 400) => (s ? String(s).slice(0, n) : undefined);

function card(p) {
  return { name: p.name, slug: p.slug, url: `/products/${p.slug}`, price: inr(p.price ?? p.priceMin), mrp: inr(p.mrp), pricePaise: p.price ?? p.priceMin, discountPercent: p.discountPercent, inStock: p.inStock, rating: p.rating?.average || undefined, material: p.material, piecesPerSet: p.piecesPerSet, capacityMl: p.capacityMl, image: p.image?.thumbUrl || p.image?.url };
}

async function ownedOrder(ctx, number) {
  const order = await Order.findOne({ user: ctx.userId, orderNumber: number }).lean();
  if (!order) return null;
  return order;
}

async function conversationPhotoIds(ctx) {
  const msgs = await ChatMessage.find({ conversation: ctx.conversationId, 'sender.type': 'customer', 'sender.user': ctx.userId, 'attachments.0': { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('attachments')
    .lean();
  return [...new Set(msgs.flatMap((m) => m.attachments.map((a) => String(a.upload))))].slice(0, 8);
}

const claimSchema = z
  .object({
    orderNumber,
    items: z.array(z.object({ sku: z.string().trim().toUpperCase().max(64), quantity: z.number().int().min(1).max(50) }).strict()).min(1).max(20),
    reason: z.enum(Object.values(RETURN_REASONS)),
    description: z.string().max(1000).optional(),
    usePhotosFromConversation: z.boolean().default(true),
  })
  .strict();

async function prepareClaim(ctx, args, type) {
  const order = await ownedOrder(ctx, args.orderNumber);
  if (!order) return { error: 'order_not_found', message: 'No order with that number on this account.' };
  const elig = await returnService.eligibility(ctx.userId, order._id);
  if (!elig.orderEligible) return { error: 'not_eligible', message: `Order status is ${order.status}; requests are possible after delivery.` };
  const lines = [];
  for (const it of args.items) {
    const e = elig.items.find((x) => x.sku === it.sku);
    if (!e) return { error: 'item_not_in_order', message: `${it.sku} is not part of order ${order.orderNumber}.` };
    if (!e.eligible) return { error: 'not_eligible', sku: it.sku, message: e.blockedReason };
    if (!e.allowedReasons.includes(args.reason)) return { error: 'reason_not_allowed', sku: it.sku, allowedReasons: e.allowedReasons, deadlines: e.deadlines };
    if (it.quantity > e.claimableQty) return { error: 'quantity_exceeds', sku: it.sku, claimableQty: e.claimableQty };
    if (type === 'return' && !e.allowedResolutions.includes('refund')) return { error: 'replacement_only', sku: it.sku, message: 'This item can be replaced but not refunded.' };
    lines.push({ orderItemId: String(e.orderItemId), sku: e.sku, name: e.name, quantity: it.quantity, value: e.unitValue * it.quantity });
  }
  const photoIds = args.usePhotosFromConversation ? await conversationPhotoIds(ctx) : [];
  const settings = await getSettings();
  const needsPhotos = settings.returns.requirePhotosForDamage && ['arrived_broken', 'arrived_chipped', 'damaged_in_shipping', 'defective'].includes(args.reason);
  if (needsPhotos && !photoIds.length) {
    return { error: 'photos_required', message: 'Ask the customer to attach at least one clear photo of the damage in this chat (use the attachment button), then try again.' };
  }
  const claimValue = lines.reduce((a, l) => a + l.value, 0);
  return { order, lines, photoIds, claimValue };
}

const tools = [
  {
    name: 'searchProducts',
    description:
      'Search the live catalog. Use for any product discovery, budgets, comparisons or gift ideas. Prices are in Indian rupees. Returns at most 8 real products with current price and stock.',
    schema: z
      .object({
        query: z.string().max(100).optional().describe('Free text, e.g. "dinner set", "whiskey glasses"'),
        category: z.string().max(80).optional().describe('Category slug or name'),
        maxPriceInr: z.number().min(0).max(1000000).optional(),
        minPriceInr: z.number().min(0).max(1000000).optional(),
        material: z.enum(MATERIALS).optional(),
        serves: z.number().int().min(1).max(50).optional().describe('Number of people a dinner set should serve'),
        minPieces: z.number().int().min(1).max(200).optional(),
        color: z.string().max(30).optional(),
        microwaveSafe: z.boolean().optional(),
        dishwasherSafe: z.boolean().optional(),
        giftWrap: z.boolean().optional(),
        sort: z.enum(['relevance', 'price_asc', 'price_desc', 'popularity', 'rating', 'newest', 'discount']).optional(),
      })
      .strict(),
    async handler(ctx, a, artifacts) {
      let category;
      if (a.category) {
        const c = await Category.findOne({ $or: [{ slug: a.category.toLowerCase() }, { name: new RegExp(`^${escapeRegex(a.category)}`, 'i') }], isActive: true }).select('_id').lean();
        category = c ? String(c._id) : undefined;
      }
      const q = {
        q: a.query,
        category,
        material: a.material ? [a.material] : undefined,
        color: a.color ? [a.color.toLowerCase()] : undefined,
        minPrice: a.minPriceInr !== undefined ? Math.round(a.minPriceInr * 100) : undefined,
        maxPrice: a.maxPriceInr !== undefined ? Math.round(a.maxPriceInr * 100) : undefined,
        serves: a.serves,
        minPieces: a.minPieces,
        microwaveSafe: a.microwaveSafe ? 'true' : undefined,
        dishwasherSafe: a.dishwasherSafe ? 'true' : undefined,
        giftWrap: a.giftWrap ? 'true' : undefined,
        inStock: 'true',
        page: 1,
        limit: 8,
        sort: a.sort || 'relevance',
      };
      let { items, meta } = await productService.listProducts(q);
      let relaxed = false;
      if (!items.length && a.query && (category || a.material || a.serves)) {
        ({ items, meta } = await productService.listProducts({ ...q, q: undefined }));
        relaxed = true;
      }
      const cards = items.map(card);
      artifacts.products = cards.slice(0, 6);
      return { total: meta.total, relaxedTextMatch: relaxed, products: cards.map(({ image, ...c }) => c) };
    },
  },
  {
    name: 'getProductDetails',
    description: 'Full verified details of one product by slug: variants, prices, stock status, material, dimensions, set composition, care/safety attributes (only verified ones), return policy.',
    schema: z.object({ slug: z.string().max(140) }).strict(),
    async handler(ctx, { slug }, artifacts) {
      const p = await productService.getPublicProduct(slug).catch(() => null);
      if (!p) return { error: 'not_found' };
      artifacts.products = [card({ ...p, price: p.variants[0]?.price, mrp: p.variants[0]?.mrp, image: require('../products/product.model').publicImages(p.images)[0], material: p.specs?.material, piecesPerSet: p.specs?.piecesPerSet })];
      return {
        name: p.name,
        url: `/products/${p.slug}`,
        brand: p.brand,
        descriptionUntrusted: untrusted(p.description, 600),
        highlights: p.highlights?.slice(0, 6),
        variants: p.variants.map((v) => ({ sku: v.sku, title: v.title, attributes: v.attributes, price: inr(v.price), mrp: inr(v.mrp), stockStatus: v.stockStatus, onlyLeft: v.onlyLeft })),
        specs: p.specs,
        verifiedCare: p.care,
        isFragile: p.isFragile,
        giftWrapAvailable: p.giftWrapAvailable,
        returnPolicy: p.returnPolicy,
        rating: p.rating,
        bundleContents: p.bundleItems,
      };
    },
  },
  {
    name: 'getAvailableCategories',
    description: 'List product categories and sub-categories.',
    schema: z.object({}).strict(),
    async handler() {
      return cache.wrap(cache.NS.CATEGORIES, 'ai-cats', 600, async () => {
        const cats = await Category.find({ isActive: true }).select('name slug level parent').sort({ level: 1, sortOrder: 1 }).lean();
        return { categories: cats.map((c) => ({ name: c.name, slug: c.slug, level: c.level })) };
      });
    },
  },
  {
    name: 'getActivePromotions',
    description: 'Currently live sales, festival campaigns, automatic offers and public coupons.',
    schema: z.object({}).strict(),
    async handler() {
      const { Coupon } = require('../promotions/promotion.models');
      const promos = await promotionService.activePromotions();
      const now = new Date();
      const coupons = await Coupon.find({ isActive: true, isPublic: true, startsAt: { $lte: now }, endsAt: { $gte: now } }).select('code description discountType value maxDiscount minCartValue endsAt').lean();
      const fmt = (d) => (d.discountType === 'percentage' ? `${d.value / 100}% off` : d.discountType === 'fixed' ? `${inr(d.value)} off` : 'Free shipping');
      return {
        promotions: promos.map((p) => ({ name: p.name, offer: fmt(p), maxDiscount: inr(p.maxDiscount), minCartValue: inr(p.minCartValue), campaign: p._campaign?.name, endsAt: p.endsAt })),
        coupons: coupons.map((c) => ({ code: c.code, offer: fmt(c), minCartValue: inr(c.minCartValue), maxDiscount: inr(c.maxDiscount), endsAt: c.endsAt, description: untrusted(c.description, 200) })),
      };
    },
  },
  {
    name: 'checkDeliveryServiceability',
    description: 'Whether we deliver to an Indian PIN code, COD availability and estimated delivery date.',
    schema: z.object({ pincode: z.string().regex(/^[1-9]\d{5}$/) }).strict(),
    handler: (ctx, { pincode }) => shippingService.checkServiceability(pincode).then(({ extraFee, ...r }) => r),
  },
  {
    name: 'getStorePolicies',
    description: 'Shipping charges, free-shipping threshold, COD rules, return/replacement windows and damage reporting rules.',
    schema: z.object({}).strict(),
    async handler() {
      const s = await getSettings();
      return {
        paymentMethods: ['UPI (online)', 'Cash on Delivery'],
        shipping: { baseFee: inr(s.shipping.baseFee), freeShippingAbove: inr(s.shipping.freeShippingThreshold), fragileHandlingFee: inr(s.shipping.fragileSurcharge), typicalDeliveryDays: s.shipping.defaultEstimatedDays },
        cod: { enabled: s.cod.enabled, fee: inr(s.cod.fee), maxOrderValue: inr(s.cod.maxOrderValue), requiresVerifiedPhone: s.cod.requireVerifiedPhone },
        returns: { returnWindowDays: s.returns.defaultWindowDays, damageReportWindowDays: s.returns.damageReportWindowDays, changeOfMindReturns: s.returns.allowChangeOfMind, photosRequiredForDamage: s.returns.requirePhotosForDamage },
        cancellation: 'Orders can be cancelled until they are packed.',
        giftWrap: { available: s.giftWrap.enabled, fee: inr(s.giftWrap.fee) },
      };
    },
  },
  {
    name: 'getAuthenticatedCustomerOrders',
    description: "The signed-in customer's own recent orders (never anyone else's). Optional filter by product name or status.",
    schema: z.object({ productQuery: z.string().max(80).optional(), status: z.string().max(30).optional(), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    async handler(ctx, { productQuery, status, limit }) {
      const filter = { user: ctx.userId };
      if (status) filter.status = status;
      if (productQuery) filter['items.name'] = new RegExp(escapeRegex(productQuery), 'i');
      const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit).select('orderNumber status paymentMethod paymentStatus pricing.total items.name items.sku items.quantity createdAt deliveredAt estimatedDeliveryDate').lean();
      return {
        orders: orders.map((o) => ({ orderNumber: o.orderNumber, status: o.status, placedAt: o.createdAt, deliveredAt: o.deliveredAt, estimatedDelivery: o.estimatedDeliveryDate, total: inr(o.pricing.total), payment: `${o.paymentMethod.toUpperCase()} (${o.paymentStatus})`, items: o.items.map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity })) })),
      };
    },
  },
  {
    name: 'getOrderTracking',
    description: "Status timeline and shipment tracking for one of the customer's orders.",
    schema: z.object({ orderNumber }).strict(),
    async handler(ctx, { orderNumber: number }) {
      const o = await ownedOrder(ctx, number);
      if (!o) return { error: 'order_not_found' };
      const shipments = await Shipment.find({ order: o._id }).select('kind courier awb trackingUrl status events').lean();
      return {
        orderNumber: o.orderNumber,
        status: o.status,
        estimatedDelivery: o.estimatedDeliveryDate,
        deliveredTo: { city: o.shippingAddress.city, pincode: o.shippingAddress.pincode },
        timeline: o.statusHistory.map((h) => ({ status: h.to, at: h.at })),
        shipments: shipments.map((s) => ({ kind: s.kind, courier: s.courier, awb: s.awb, trackingUrl: s.trackingUrl, status: s.status, latest: s.events.slice(-3) })),
        cancellable: CUSTOMER_CANCELLABLE.includes(o.status),
      };
    },
  },
  {
    name: 'getCustomerReturnEligibility',
    description: 'For one of the customer\'s delivered orders: which items can be returned/replaced, allowed reasons, deadlines, and open requests.',
    schema: z.object({ orderNumber }).strict(),
    async handler(ctx, { orderNumber: number }) {
      const o = await ownedOrder(ctx, number);
      if (!o) return { error: 'order_not_found' };
      const e = await returnService.eligibility(ctx.userId, o._id);
      return {
        orderNumber: e.orderNumber,
        status: e.status,
        deliveredAt: e.deliveredAt,
        items: e.items.map((i) => ({ sku: i.sku, name: i.name, claimableQty: i.claimableQty, eligible: i.eligible, blockedReason: i.blockedReason, allowedReasons: i.allowedReasons, allowedResolutions: i.allowedResolutions, deadlines: i.deadlines, isSet: i.isBundle })),
        openRequests: e.openRequests.map((r) => ({ requestNumber: r.requestNumber, status: r.status, type: r.type })),
        policy: e.policy,
      };
    },
  },
  {
    name: 'createReplacementRequest',
    description:
      'PREPARE a replacement request (e.g. broken glass, chipped plate, wrong or missing item). This does not submit anything: it returns a proposal the customer must confirm with the on-screen button. Photos the customer attached in this chat are included automatically.',
    schema: claimSchema,
    async handler(ctx, args, artifacts) {
      const prep = await prepareClaim(ctx, args, 'replacement');
      if (prep.error) return prep;
      const type = args.reason === RETURN_REASONS.MISSING_ITEM ? 'missing_item' : 'replacement';
      const proposal = await createProposal({
        scope: 'customer',
        requestedFor: ctx.userId,
        conversation: ctx.conversationId,
        tool: 'createReplacementRequest',
        args: { orderId: String(prep.order._id), type, reason: args.reason, preferredResolution: 'replacement', description: args.description, photoIds: prep.photoIds, items: prep.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })) },
        title: `Replacement for order ${prep.order.orderNumber}`,
        preview: { orderNumber: prep.order.orderNumber, items: prep.lines.map((l) => ({ name: l.name, sku: l.sku, quantity: l.quantity })), reason: args.reason, resolution: 'replacement', photos: prep.photoIds.length, claimValue: inr(prep.claimValue) },
      });
      artifacts.proposals.push(proposal);
      return { proposalId: String(proposal._id), status: 'awaiting_customer_confirmation', summary: proposal.preview, note: 'Tell the customer to review and press Confirm. Do not say it has been submitted.' };
    },
  },
  {
    name: 'createReturnRequest',
    description: 'PREPARE a return-for-refund request. Returns a proposal the customer must confirm; nothing is submitted by this call.',
    schema: claimSchema,
    async handler(ctx, args, artifacts) {
      const prep = await prepareClaim(ctx, args, 'return');
      if (prep.error) return prep;
      const proposal = await createProposal({
        scope: 'customer',
        requestedFor: ctx.userId,
        conversation: ctx.conversationId,
        tool: 'createReturnRequest',
        args: { orderId: String(prep.order._id), type: 'return', reason: args.reason, preferredResolution: 'refund', description: args.description, photoIds: prep.photoIds, items: prep.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })) },
        title: `Return for order ${prep.order.orderNumber}`,
        preview: { orderNumber: prep.order.orderNumber, items: prep.lines.map((l) => ({ name: l.name, sku: l.sku, quantity: l.quantity })), reason: args.reason, resolution: 'refund to original payment method', photos: prep.photoIds.length, estimatedRefund: inr(prep.claimValue) },
      });
      artifacts.proposals.push(proposal);
      return { proposalId: String(proposal._id), status: 'awaiting_customer_confirmation', summary: proposal.preview, note: 'Refund amounts are confirmed only after review; never promise a refund has been issued.' };
    },
  },
  {
    name: 'requestOrderCancellation',
    description: 'PREPARE cancellation of an order that has not been packed yet. Returns a proposal for the customer to confirm.',
    schema: z.object({ orderNumber, reason: z.string().min(3).max(200) }).strict(),
    async handler(ctx, { orderNumber: number, reason }, artifacts) {
      const o = await ownedOrder(ctx, number);
      if (!o) return { error: 'order_not_found' };
      if (!CUSTOMER_CANCELLABLE.includes(o.status)) return { error: 'not_cancellable', status: o.status, message: o.status === 'packed' ? 'Already packed — offer to connect a human agent.' : 'Not cancellable at this stage; returns are possible after delivery.' };
      const proposal = await createProposal({
        scope: 'customer',
        requestedFor: ctx.userId,
        conversation: ctx.conversationId,
        tool: 'requestOrderCancellation',
        args: { orderId: String(o._id), reason },
        title: `Cancel order ${o.orderNumber}`,
        preview: { orderNumber: o.orderNumber, total: inr(o.pricing.total), refund: o.paymentStatus === 'paid' ? 'Full refund to your UPI account after cancellation' : 'No payment to refund', reason },
      });
      artifacts.proposals.push(proposal);
      return { proposalId: String(proposal._id), status: 'awaiting_customer_confirmation', summary: proposal.preview };
    },
  },
  {
    name: 'createSupportTicket',
    description: 'Open a support ticket for issues you cannot resolve (payment problems, delivery complaints, anything needing staff).',
    schema: z.object({ subject: z.string().min(5).max(150), description: z.string().min(10).max(1500), category: z.enum(['order', 'delivery', 'return', 'payment', 'product', 'account', 'other']), orderNumber: orderNumber.optional() }).strict(),
    async handler(ctx, a) {
      let orderId;
      if (a.orderNumber) orderId = (await ownedOrder(ctx, a.orderNumber))?._id;
      const t = await chatService.createTicket(ctx.userId, { subject: a.subject, description: a.description, category: a.category, orderId, conversationId: ctx.conversationId, source: 'ai' });
      return { ticketNumber: t.ticketNumber, status: t.status };
    },
  },
  {
    name: 'transferToHumanSupport',
    description: 'Hand the conversation to a human agent. Use when the customer asks for a person, is upset, or the request is outside policy.',
    schema: z.object({ reason: z.string().min(3).max(200), category: z.enum(['order', 'delivery', 'return', 'payment', 'product', 'account', 'other']).default('other') }).strict(),
    async handler(ctx, { reason, category }, artifacts) {
      artifacts.handoff = { reason, category };
      return { status: 'transfer_scheduled', message: 'The customer will be connected to an agent after your reply.' };
    },
  },
];

/** Executors run only after explicit customer confirmation, with re-validation inside the services. */
const executors = {
  async createReplacementRequest(proposal) {
    const { request } = await returnService.createRequest(String(proposal.requestedFor), { ...proposal.args, idempotencyKey: `ai-${proposal._id}` }, { source: 'ai' });
    return { requestNumber: request.requestNumber, status: request.status, autoApproved: request.autoApproved, replacement: request.replacement ? String(request.replacement) : undefined };
  },
  async createReturnRequest(proposal) {
    const { request } = await returnService.createRequest(String(proposal.requestedFor), { ...proposal.args, idempotencyKey: `ai-${proposal._id}` }, { source: 'ai' });
    return { requestNumber: request.requestNumber, status: request.status, autoApproved: request.autoApproved, refund: request.refund ? String(request.refund) : undefined };
  },
  async requestOrderCancellation(proposal) {
    const { order, refund } = await orderService.cancelOrder(proposal.args.orderId, { actor: { type: 'customer', id: proposal.requestedFor }, reason: proposal.args.reason, customerId: proposal.requestedFor });
    return { orderNumber: order.orderNumber, status: order.status, refund: refund ? { refundNumber: refund.refundNumber, status: refund.status } : null };
  },
};

module.exports = { tools, executors };
