'use strict';

const { z } = require('zod');
const a = require('./analytics.service');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { PERMISSIONS: P } = require('../../constants/roles');

const rangeQ = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const api = createRouter({ prefix: '/api/v1/admin/analytics', tag: 'Admin: Analytics' });

const def = (path, summary, permission, query, fn) => api.get(path, { summary, permission, query }, async (req, res) => ok(res, await fn(req.query)));

def('/dashboard', 'Today at a glance', [P.REPORTS_SALES, P.ORDERS_READ], undefined, () => a.dashboard());
def('/sales', 'Sales: GOV, net, collected revenue, refunds, AOV, payment mix, time series', P.REPORTS_SALES, rangeQ.extend({ granularity: z.enum(['day', 'week', 'month']).default('day') }), a.salesSummary);
def('/cod', 'COD outstanding / collected / unsettled', [P.REPORTS_FINANCIAL, P.PAYMENTS_READ], rangeQ, a.codSummary);
def('/bestsellers', 'Best-selling products (optionally within a category)', P.REPORTS_SALES, rangeQ.extend({ category: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }), a.bestsellers);
def('/categories', 'Best-selling categories', P.REPORTS_SALES, rangeQ.extend({ limit: z.coerce.number().int().min(1).max(50).default(10) }), a.bestsellingCategories);
def('/inventory/low-stock', 'Low-stock SKUs', P.REPORTS_INVENTORY, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), a.lowStock);
def('/inventory/replenishment', 'Reorder suggestions from sales velocity', P.REPORTS_INVENTORY, z.object({ leadTimeDays: z.coerce.number().int().min(1).max(120).default(14), coverDays: z.coerce.number().int().min(1).max(180).default(30) }), a.replenishment);
def('/inventory/valuation', 'Inventory valuation at cost and retail', [P.REPORTS_FINANCIAL, P.CATALOG_COST], undefined, () => a.inventoryValuation());
def('/cancellations', 'Products with the highest cancellation rates', P.REPORTS_SALES, rangeQ.extend({ minOrders: z.coerce.number().int().min(1).default(3) }), a.cancellationRates);
def('/returns', 'Return / replacement summary', P.RETURNS_READ, rangeQ, a.returnsSummary);
def('/damage-claims', 'Damage claims by SKU vs units sold', P.RETURNS_READ, rangeQ.extend({ damageOnly: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') }), a.claimsBySku);
def('/coupons', 'Coupon usage and underperformers', P.PROMOTIONS_READ, rangeQ, a.couponPerformance);
def('/customers', 'New vs repeat customers', P.REPORTS_CUSTOMERS, rangeQ, a.customerSummary);
def('/fulfillment', 'Average time to ship and in transit', [P.ORDERS_READ, P.REPORTS_SALES], rangeQ, a.fulfillmentTimes);
def('/support', 'Support volume and AI automation rate', P.SUPPORT_READ, rangeQ, a.supportSummary);
def('/ai-usage', 'Gemini usage, tokens and latency', P.AI_SETTINGS, rangeQ, a.aiUsage);

module.exports = { routers: [api] };
