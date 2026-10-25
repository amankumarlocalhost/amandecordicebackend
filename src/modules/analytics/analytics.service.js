'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../orders/order.model');
const Product = require('../products/product.model');
const Category = require('../categories/category.model');
const User = require('../users/user.model');
const ReturnRequest = require('../returns/return.model');
const { Inventory } = require('../inventory/inventory.models');
const { Payment, Refund } = require('../payments/payment.models');
const { Coupon, CouponRedemption, Campaign, Promotion } = require('../promotions/promotion.models');
const { Conversation, SupportTicket } = require('../chat/chat.models');
const cache = require('../../services/cache');
const { getSettings } = require('../settings/settings');
const { badRequest } = require('../../utils/errors');
const { DAMAGE_REASONS, ORDER_STATUS: S } = require('../../constants/statuses');

/**
 * Metric definitions (all money in paise):
 *  - Confirmed order        : an order with confirmedAt set (COD at placement, UPI once payment is captured).
 *  - Gross order value (GOV): Σ total of orders confirmed in the range (includes orders later cancelled).
 *  - Cancelled value        : Σ total of those orders that are now cancelled.
 *  - Net order value        : GOV − cancelled value.
 *  - Collected revenue      : UPI captured in range + COD cash collected in range. Unpaid COD is NEVER revenue.
 *  - Refunds                : refunds confirmed processed in range.
 *  - Net collected revenue  : collected revenue − refunds.
 *  - AOV                    : GOV / confirmed orders.
 */

const MAX_RANGE_DAYS = 366;
const TZ = 'Asia/Kolkata';

function range({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  if (start > end) throw badRequest('`from` must be before `to`');
  if ((end - start) / 86400000 > MAX_RANGE_DAYS) throw badRequest(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

function cached(name, args, ttl, fn) {
  const key = crypto.createHash('sha1').update(`${name}:${JSON.stringify(args)}`).digest('hex');
  return cache.wrap(cache.NS.REPORTS, key, ttl, fn);
}

const DATE_FORMATS = { day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m' };

async function salesSummary({ from, to, granularity = 'day' } = {}) {
  const { start, end } = range({ from, to });
  return cached('sales', { start, end, granularity }, 300, async () => {
    const fmt = DATE_FORMATS[granularity] || DATE_FORMATS.day;
    const [series, totals, upi, cod, refunds, byMethod] = await Promise.all([
      Order.aggregate([
        { $match: { confirmedAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: { $dateToString: { format: fmt, date: '$confirmedAt', timezone: TZ } },
            orders: { $sum: 1 },
            gov: { $sum: '$pricing.total' },
            cancelledValue: { $sum: { $cond: [{ $eq: ['$status', S.CANCELLED] }, '$pricing.total', 0] } },
            units: { $sum: { $sum: '$items.quantity' } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $match: { confirmedAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            gov: { $sum: '$pricing.total' },
            cancelledOrders: { $sum: { $cond: [{ $eq: ['$status', S.CANCELLED] }, 1, 0] } },
            cancelledValue: { $sum: { $cond: [{ $eq: ['$status', S.CANCELLED] }, '$pricing.total', 0] } },
            promotionDiscount: { $sum: '$pricing.promotionDiscount' },
            couponDiscount: { $sum: '$pricing.couponDiscount' },
            shippingFees: { $sum: '$pricing.shippingFee' },
            codFees: { $sum: '$pricing.codFee' },
            giftWrapFees: { $sum: '$pricing.giftWrapFee' },
            tax: { $sum: '$pricing.taxTotal' },
          },
        },
      ]),
      Payment.aggregate([{ $match: { method: 'upi', status: 'captured', capturedAt: { $gte: start, $lte: end } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { paymentMethod: 'cod', 'cod.collectedAt': { $gte: start, $lte: end } } }, { $group: { _id: null, amount: { $sum: '$cod.collectedAmount' }, count: { $sum: 1 } } }]),
      Refund.aggregate([{ $match: { status: 'processed', processedAt: { $gte: start, $lte: end } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { confirmedAt: { $gte: start, $lte: end } } }, { $group: { _id: '$paymentMethod', orders: { $sum: 1 }, value: { $sum: '$pricing.total' } } }]),
    ]);
    const t = totals[0] || { orders: 0, gov: 0, cancelledOrders: 0, cancelledValue: 0, promotionDiscount: 0, couponDiscount: 0, shippingFees: 0, codFees: 0, giftWrapFees: 0, tax: 0 };
    delete t._id;
    const collected = (upi[0]?.amount || 0) + (cod[0]?.amount || 0);
    return {
      range: { from: start, to: end, granularity, timezone: TZ },
      totals: {
        ...t,
        netOrderValue: t.gov - t.cancelledValue,
        averageOrderValue: t.orders ? Math.round(t.gov / t.orders) : 0,
        cancellationRate: t.orders ? t.cancelledOrders / t.orders : 0,
        collected: { upi: upi[0]?.amount || 0, cod: cod[0]?.amount || 0, total: collected },
        refundsProcessed: refunds[0]?.amount || 0,
        netCollectedRevenue: collected - (refunds[0]?.amount || 0),
      },
      paymentMethods: byMethod.map((m) => ({ method: m._id, orders: m.orders, value: m.value })),
      series: series.map((s) => ({ period: s._id, orders: s.orders, gov: s.gov, cancelledValue: s.cancelledValue, units: s.units })),
    };
  });
}

async function codSummary({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const [outstanding, collected, unsettled] = await Promise.all([
    Order.aggregate([{ $match: { paymentMethod: 'cod', paymentStatus: 'cod_due', status: { $ne: S.CANCELLED } } }, { $group: { _id: '$status', orders: { $sum: 1 }, amount: { $sum: '$pricing.total' } } }]),
    Order.aggregate([{ $match: { paymentMethod: 'cod', 'cod.collectedAt': { $gte: start, $lte: end } } }, { $group: { _id: null, orders: { $sum: 1 }, amount: { $sum: '$cod.collectedAmount' } } }]),
    Order.aggregate([{ $match: { paymentMethod: 'cod', 'cod.collectedAt': { $ne: null }, 'cod.settledAt': null } }, { $group: { _id: null, orders: { $sum: 1 }, amount: { $sum: '$cod.collectedAmount' } } }]),
  ]);
  return {
    outstandingByStatus: outstanding.map((o) => ({ status: o._id, orders: o.orders, amount: o.amount })),
    outstandingTotal: outstanding.reduce((a, o) => a + o.amount, 0),
    collectedInRange: collected[0] || { orders: 0, amount: 0 },
    collectedNotSettled: unsettled[0] || { orders: 0, amount: 0 },
  };
}

async function categoryProductIds(category) {
  if (!category) return null;
  const cat = mongoose.isValidObjectId(category) ? await Category.findById(category).lean() : await Category.findOne({ $or: [{ slug: String(category).toLowerCase() }, { name: new RegExp(`^${String(category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }] }).lean();
  if (!cat) return [];
  const ids = await Product.find({ categoryPath: cat._id }).distinct('_id');
  return ids;
}

async function bestsellers({ from, to, category, limit = 10 } = {}) {
  const { start, end } = range({ from, to });
  const productIds = await categoryProductIds(category);
  return cached('bestsellers', { start, end, category, limit }, 300, async () => {
    const match = { confirmedAt: { $gte: start, $lte: end }, status: { $ne: S.CANCELLED } };
    const rows = await Order.aggregate([
      { $match: match },
      { $unwind: '$items' },
      ...(productIds ? [{ $match: { 'items.product': { $in: productIds } } }] : []),
      { $group: { _id: '$items.product', name: { $first: '$items.name' }, units: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' }, orders: { $sum: 1 } } },
      { $sort: { units: -1 } },
      { $limit: Math.min(limit, 50) },
    ]);
    return rows.map((r) => ({ productId: r._id, name: r.name, units: r.units, revenue: r.revenue, orders: r.orders }));
  });
}

async function bestsellingCategories({ from, to, limit = 10 } = {}) {
  const { start, end } = range({ from, to });
  return cached('bestcats', { start, end, limit }, 300, async () => {
    const rows = await Order.aggregate([
      { $match: { confirmedAt: { $gte: start, $lte: end }, status: { $ne: S.CANCELLED } } },
      { $unwind: '$items' },
      { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'p', pipeline: [{ $project: { categoryPath: 1 } }] } },
      { $unwind: '$p' },
      { $project: { cat: { $arrayElemAt: ['$p.categoryPath', 0] }, units: '$items.quantity', revenue: '$items.total' } },
      { $group: { _id: '$cat', units: { $sum: '$units' }, revenue: { $sum: '$revenue' } } },
      { $sort: { revenue: -1 } },
      { $limit: limit },
      { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'c', pipeline: [{ $project: { name: 1, slug: 1 } }] } },
    ]);
    return rows.map((r) => ({ categoryId: r._id, name: r.c[0]?.name, units: r.units, revenue: r.revenue }));
  });
}

async function lowStock({ limit = 50 } = {}) {
  const settings = await getSettings();
  const def = settings.inventory.defaultLowStockThreshold;
  const rows = await Inventory.aggregate([
    { $addFields: { available: { $subtract: ['$onHand', '$reserved'] }, threshold: { $ifNull: ['$lowStockThreshold', def] } } },
    { $match: { $expr: { $lte: ['$available', '$threshold'] } } },
    { $sort: { available: 1 } },
    { $limit: Math.min(limit, 200) },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'p', pipeline: [{ $project: { name: 1, status: 1 } }] } },
  ]);
  return rows.map((r) => ({ sku: r.sku, product: r.p[0]?.name, productStatus: r.p[0]?.status, available: r.available, onHand: r.onHand, reserved: r.reserved, threshold: r.threshold }));
}

/** Suggests reorder quantities from 30-day sales velocity and supplier lead time (default 14 days). */
async function replenishment({ leadTimeDays = 14, coverDays = 30, limit = 50 } = {}) {
  const since = new Date(Date.now() - 30 * 86400000);
  const sales = await Order.aggregate([
    { $match: { confirmedAt: { $gte: since }, status: { $ne: S.CANCELLED } } },
    { $unwind: '$items' },
    { $project: { lines: { $cond: [{ $gt: [{ $size: { $ifNull: ['$items.bundleComponents', []] } }, 0] }, { $map: { input: '$items.bundleComponents', as: 'c', in: { sku: '$$c.sku', q: { $multiply: ['$$c.quantity', '$items.quantity'] } } } }, [{ sku: '$items.sku', q: '$items.quantity' }]] } } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.sku', units: { $sum: '$lines.q' } } },
  ]);
  const velocity = Object.fromEntries(sales.map((s) => [s._id, s.units / 30]));
  const invs = await Inventory.find({ sku: { $in: Object.keys(velocity) } }).populate('product', 'name').lean();
  const out = [];
  for (const inv of invs) {
    const perDay = velocity[inv.sku] || 0;
    const available = inv.onHand - inv.reserved;
    const daysLeft = perDay ? available / perDay : Infinity;
    if (daysLeft <= leadTimeDays + 7) {
      out.push({ sku: inv.sku, product: inv.product?.name, available, dailyVelocity: Math.round(perDay * 100) / 100, daysOfStockLeft: Math.round(daysLeft * 10) / 10, suggestedReorderQty: Math.max(0, Math.ceil(perDay * (leadTimeDays + coverDays)) - available) });
    }
  }
  return out.sort((a, b) => a.daysOfStockLeft - b.daysOfStockLeft).slice(0, limit);
}

async function inventoryValuation() {
  const rows = await Inventory.aggregate([
    { $match: { onHand: { $gt: 0 } } },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'p', pipeline: [{ $project: { variants: { sku: 1, costPrice: 1, price: 1 } } }] } },
    { $unwind: '$p' },
    { $project: { sku: 1, onHand: 1, v: { $first: { $filter: { input: '$p.variants', as: 'v', cond: { $eq: ['$$v.sku', '$sku'] } } } } } },
    { $group: { _id: null, units: { $sum: '$onHand' }, atCost: { $sum: { $multiply: ['$onHand', { $ifNull: ['$v.costPrice', 0] }] } }, atRetail: { $sum: { $multiply: ['$onHand', '$v.price'] } }, skusMissingCost: { $sum: { $cond: [{ $ifNull: ['$v.costPrice', false] }, 0, 1] } } } },
  ]);
  const r = rows[0] || { units: 0, atCost: 0, atRetail: 0, skusMissingCost: 0 };
  delete r._id;
  return r;
}

async function cancellationRates({ from, to, minOrders = 3, limit = 20 } = {}) {
  const { start, end } = range({ from, to });
  const rows = await Order.aggregate([
    { $match: { confirmedAt: { $gte: start, $lte: end } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.product', name: { $first: '$items.name' }, orders: { $sum: 1 }, cancelled: { $sum: { $cond: [{ $eq: ['$status', S.CANCELLED] }, 1, 0] } } } },
    { $match: { orders: { $gte: minOrders } } },
    { $addFields: { rate: { $divide: ['$cancelled', '$orders'] } } },
    { $sort: { rate: -1, orders: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({ productId: r._id, name: r.name, orders: r.orders, cancelled: r.cancelled, cancellationRate: Math.round(r.rate * 1000) / 1000 }));
}

/** Damage / return claims per SKU, normalised by units sold in the same window. */
async function claimsBySku({ from, to, damageOnly = true, limit = 20 } = {}) {
  const { start, end } = range({ from, to });
  const match = { createdAt: { $gte: start, $lte: end }, status: { $ne: 'cancelled' } };
  if (damageOnly) match.reason = { $in: DAMAGE_REASONS };
  const [claims, sold] = await Promise.all([
    ReturnRequest.aggregate([{ $match: match }, { $unwind: '$items' }, { $group: { _id: '$items.sku', name: { $first: '$items.name' }, claimedUnits: { $sum: '$items.quantity' }, claims: { $sum: 1 }, reasons: { $addToSet: '$reason' } } }, { $sort: { claimedUnits: -1 } }, { $limit: limit }]),
    Order.aggregate([{ $match: { confirmedAt: { $gte: start, $lte: end }, status: { $ne: S.CANCELLED } } }, { $unwind: '$items' }, { $group: { _id: '$items.sku', units: { $sum: '$items.quantity' } } }]),
  ]);
  const soldMap = Object.fromEntries(sold.map((s) => [s._id, s.units]));
  return claims.map((c) => ({ sku: c._id, name: c.name, claims: c.claims, claimedUnits: c.claimedUnits, unitsSold: soldMap[c._id] || 0, claimRate: soldMap[c._id] ? Math.round((c.claimedUnits / soldMap[c._id]) * 1000) / 1000 : null, reasons: c.reasons }));
}

async function returnsSummary({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const [byStatus, byReason, byType, confirmedOrders] = await Promise.all([
    ReturnRequest.aggregate([{ $match: { createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ReturnRequest.aggregate([{ $match: { createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$reason', n: { $sum: 1 }, value: { $sum: '$claimValue' } } }, { $sort: { n: -1 } }]),
    ReturnRequest.aggregate([{ $match: { createdAt: { $gte: start, $lte: end } } }, { $group: { _id: { type: '$type', source: '$source', auto: '$autoApproved' }, n: { $sum: 1 } } }]),
    Order.countDocuments({ confirmedAt: { $gte: start, $lte: end } }),
  ]);
  const total = byStatus.reduce((a, b) => a + b.n, 0);
  return {
    total,
    claimRatePerOrder: confirmedOrders ? Math.round((total / confirmedOrders) * 1000) / 1000 : 0,
    byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    byReason: byReason.map((r) => ({ reason: r._id, count: r.n, value: r.value })),
    byType: byType.map((t) => ({ ...t._id, count: t.n })),
    awaitingReview: byStatus.find((s) => s._id === 'awaiting_review')?.n || 0,
  };
}

async function couponPerformance({ from, to, limit = 20 } = {}) {
  const { start, end } = range({ from, to });
  const rows = await CouponRedemption.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end }, status: 'redeemed' } },
    { $group: { _id: '$coupon', code: { $first: '$code' }, redemptions: { $sum: 1 }, discount: { $sum: '$discount' }, orders: { $addToSet: '$order' } } },
    { $lookup: { from: 'orders', localField: 'orders', foreignField: '_id', as: 'o', pipeline: [{ $project: { 'pricing.total': 1, status: 1 } }] } },
    { $project: { code: 1, redemptions: 1, discount: 1, revenue: { $sum: '$o.pricing.total' } } },
    { $sort: { redemptions: -1 } },
  ]);
  const used = new Set(rows.map((r) => String(r._id)));
  const now = new Date();
  const live = await Coupon.find({ isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } }).select('code usageLimit usedCount startsAt endsAt').lean();
  const underperforming = live
    .filter((c) => !used.has(String(c._id)) || (c.usageLimit && c.usedCount / c.usageLimit < 0.1))
    .map((c) => ({ code: c.code, usedCount: c.usedCount, usageLimit: c.usageLimit, endsAt: c.endsAt, daysLive: Math.round((now - c.startsAt) / 86400000) }));
  return { performance: rows.slice(0, limit).map((r) => ({ code: r.code, redemptions: r.redemptions, discount: r.discount, revenue: r.revenue, discountShare: r.revenue ? Math.round((r.discount / (r.revenue + r.discount)) * 1000) / 1000 : 0 })), underperforming };
}

async function customerSummary({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const [newCustomers, repeat, buyers] = await Promise.all([
    User.countDocuments({ role: 'customer', createdAt: { $gte: start, $lte: end } }),
    User.countDocuments({ role: 'customer', 'stats.ordersCount': { $gte: 2 } }),
    User.countDocuments({ role: 'customer', 'stats.ordersCount': { $gte: 1 } }),
  ]);
  const firstTime = await Order.aggregate([
    { $match: { confirmedAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$user', first: { $min: '$confirmedAt' } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u', pipeline: [{ $project: { 'stats.firstOrderAt': 1 } }] } },
    { $project: { isNew: { $gte: [{ $first: '$u.stats.firstOrderAt' }, start] } } },
    { $group: { _id: '$isNew', n: { $sum: 1 } } },
  ]);
  return {
    newRegistrations: newCustomers,
    purchasingCustomersInRange: firstTime.reduce((a, b) => a + b.n, 0),
    firstTimeBuyersInRange: firstTime.find((f) => f._id === true)?.n || 0,
    returningBuyersInRange: firstTime.find((f) => f._id === false)?.n || 0,
    allTimeBuyers: buyers,
    allTimeRepeatBuyers: repeat,
    repeatRate: buyers ? Math.round((repeat / buyers) * 1000) / 1000 : 0,
  };
}

async function fulfillmentTimes({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const [r] = await Order.aggregate([
    { $match: { confirmedAt: { $gte: start, $lte: end }, shippedAt: { $ne: null } } },
    { $project: { toShip: { $subtract: ['$shippedAt', '$confirmedAt'] }, toDeliver: { $cond: [{ $ifNull: ['$deliveredAt', false] }, { $subtract: ['$deliveredAt', '$shippedAt'] }, null] } } },
    { $group: { _id: null, shipped: { $sum: 1 }, avgHoursToShip: { $avg: '$toShip' }, avgHoursInTransit: { $avg: '$toDeliver' } } },
  ]);
  const h = (ms) => (ms ? Math.round((ms / 3600000) * 10) / 10 : null);
  return { shipped: r?.shipped || 0, avgHoursToShip: h(r?.avgHoursToShip), avgHoursInTransit: h(r?.avgHoursInTransit) };
}

async function ordersAwaitingDispatch() {
  const rows = await Order.aggregate([
    { $match: { status: { $in: [S.CONFIRMED, S.PROCESSING, S.PACKED] } } },
    { $group: { _id: '$status', count: { $sum: 1 }, oldest: { $min: '$confirmedAt' }, value: { $sum: '$pricing.total' } } },
  ]);
  return { total: rows.reduce((a, r) => a + r.count, 0), byStatus: rows.map((r) => ({ status: r._id, count: r.count, oldestConfirmedAt: r.oldest, value: r.value })) };
}

async function campaignsEnding({ withinHours = 48 } = {}) {
  const now = new Date();
  const until = new Date(now.getTime() + withinHours * 3600000);
  const [campaigns, promotions, coupons] = await Promise.all([
    Campaign.find({ isActive: true, endsAt: { $gte: now, $lte: until } }).select('name slug endsAt timezone').lean(),
    Promotion.find({ isActive: true, endsAt: { $gte: now, $lte: until } }).select('name endsAt').lean(),
    Coupon.find({ isActive: true, endsAt: { $gte: now, $lte: until } }).select('code endsAt usedCount usageLimit').lean(),
  ]);
  return { campaigns, promotions, coupons };
}

async function supportSummary({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const [convs, tickets, aiReturns] = await Promise.all([
    Conversation.aggregate([{ $match: { createdAt: { $gte: start, $lte: end } } }, { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: { createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ReturnRequest.countDocuments({ createdAt: { $gte: start, $lte: end }, source: 'ai' }),
  ]);
  const total = convs.reduce((a, c) => a + c.n, 0);
  const handledByAi = convs.filter((c) => c._id.channel === 'ai').reduce((a, c) => a + c.n, 0);
  return {
    conversations: total,
    resolvedWithoutHuman: handledByAi,
    automationRate: total ? Math.round((handledByAi / total) * 1000) / 1000 : 0,
    byChannelStatus: convs.map((c) => ({ ...c._id, count: c.n })),
    tickets: Object.fromEntries(tickets.map((t) => [t._id, t.n])),
    requestsCreatedByAi: aiReturns,
  };
}

async function aiUsage({ from, to } = {}) {
  const { start, end } = range({ from, to });
  const { AIUsageRecord } = require('../ai/ai.models');
  const rows = await AIUsageRecord.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { scope: '$scope', status: '$status' }, requests: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, avgMs: { $avg: '$durationMs' } } },
  ]);
  return rows.map((r) => ({ ...r._id, requests: r.requests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, avgLatencyMs: Math.round(r.avgMs || 0) }));
}

async function dashboard() {
  const IST_MS = 5.5 * 3600000; // India has no DST, so a fixed offset is exact
  const todayStart = new Date(Math.floor((Date.now() + IST_MS) / 86400000) * 86400000 - IST_MS);
  const [today, dispatch, returns, low, pendingUpi] = await Promise.all([
    salesSummary({ from: todayStart, to: new Date() }),
    ordersAwaitingDispatch(),
    ReturnRequest.countDocuments({ status: 'awaiting_review' }),
    lowStock({ limit: 10 }),
    Order.countDocuments({ status: S.PENDING }),
  ]);
  return { today: today.totals, awaitingDispatch: dispatch, returnsAwaitingReview: returns, lowStock: low, pendingPayments: pendingUpi };
}

module.exports = {
  range,
  salesSummary,
  codSummary,
  bestsellers,
  bestsellingCategories,
  lowStock,
  replenishment,
  inventoryValuation,
  cancellationRates,
  claimsBySku,
  returnsSummary,
  couponPerformance,
  customerSummary,
  fulfillmentTimes,
  ordersAwaitingDispatch,
  campaignsEnding,
  supportSummary,
  aiUsage,
  dashboard,
};
