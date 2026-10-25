'use strict';

const { z } = require('zod');
const service = require('./inventory.service');
const { Inventory, InventoryMovement, Supplier, PurchaseRecord } = require('./inventory.models');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, badRequest } = require('../../utils/errors');
const { objectId, paginationSchema, paginate, escapeRegex, pageMeta } = require('../../utils/common');
const { getSettings } = require('../settings/settings');
const { PERMISSIONS } = require('../../constants/roles');
const { withTransaction } = require('../../config/database');

const api = createRouter({ prefix: '/api/v1/admin/inventory', tag: 'Admin: Inventory' });
const sku = z.string().trim().toUpperCase().min(2).max(64);
const actor = (req) => ({ type: 'staff', id: req.auth.userId });

api.get(
  '/',
  {
    summary: 'Stock levels per SKU',
    permission: PERMISSIONS.INVENTORY_READ,
    query: paginationSchema.extend({ q: z.string().max(64).optional(), status: z.enum(['low', 'out', 'quarantine', 'damaged']).optional() }),
  },
  async (req, res) => {
    const { page, limit, q, status } = req.query;
    const settings = await getSettings();
    const filter = {};
    if (q) filter.sku = new RegExp(escapeRegex(q.toUpperCase()));
    const avail = { $subtract: ['$onHand', '$reserved'] };
    if (status === 'out') filter.$expr = { $lte: [avail, 0] };
    if (status === 'low') filter.$expr = { $lte: [avail, { $ifNull: ['$lowStockThreshold', settings.inventory.defaultLowStockThreshold] }] };
    if (status === 'quarantine') filter.quarantine = { $gt: 0 };
    if (status === 'damaged') filter.damaged = { $gt: 0 };
    const [items, total] = await Promise.all([
      Inventory.find(filter).sort({ sku: 1 }).skip((page - 1) * limit).limit(limit).populate('product', 'name slug status').lean(),
      Inventory.countDocuments(filter),
    ]);
    ok(
      res,
      items.map((i) => ({ ...i, available: i.onHand - i.reserved, threshold: i.lowStockThreshold ?? settings.inventory.defaultLowStockThreshold })),
      { meta: pageMeta(page, limit, total) },
    );
  },
);

api.get('/:sku', { summary: 'SKU stock with recent movements', permission: PERMISSIONS.INVENTORY_READ, params: z.object({ sku }) }, async (req, res) => {
  const inv = await Inventory.findOne({ sku: req.params.sku }).populate('product', 'name slug').lean();
  if (!inv) throw notFound('SKU');
  const movements = await InventoryMovement.find({ sku: req.params.sku }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, { ...inv, available: inv.onHand - inv.reserved, movements });
});

api.get(
  '/:sku/movements',
  { summary: 'Paginated stock movement history', permission: PERMISSIONS.INVENTORY_READ, params: z.object({ sku }), query: paginationSchema },
  async (req, res) => {
    const { items, meta } = await paginate(InventoryMovement, { sku: req.params.sku }, req.query);
    ok(res, items, { meta });
  },
);

api.post(
  '/:sku/adjust',
  { summary: 'Manual stock adjustment (+/-) with reason', permission: PERMISSIONS.INVENTORY_WRITE, params: z.object({ sku }), body: z.object({ delta: z.number().int().min(-100000).max(100000), reason: z.string().trim().min(3).max(300) }) },
  async (req, res) => {
    const doc = await service.adjust(req.params.sku, req.body.delta, req.body.reason, actor(req));
    await audit.record({ req, action: 'inventory.adjust', resource: { type: 'sku', id: req.params.sku }, metadata: req.body });
    ok(res, { ...doc.toObject(), available: doc.onHand - doc.reserved }, { message: 'Stock adjusted' });
  },
);

api.post(
  '/:sku/damage',
  { summary: 'Record warehouse breakage (moves sellable stock to damaged)', permission: PERMISSIONS.INVENTORY_WRITE, params: z.object({ sku }), body: z.object({ quantity: z.number().int().min(1).max(10000), reason: z.string().trim().min(3).max(300) }) },
  async (req, res) => {
    const doc = await service.warehouseDamage(req.params.sku, req.body.quantity, req.body.reason, actor(req));
    await audit.record({ req, action: 'inventory.damage', resource: { type: 'sku', id: req.params.sku }, metadata: req.body });
    ok(res, doc, { message: 'Damage recorded' });
  },
);

api.post(
  '/:sku/disposition',
  {
    summary: 'Decide what happens to quarantined units (RTO / returns): restock, damaged or unusable',
    permission: PERMISSIONS.INVENTORY_WRITE,
    params: z.object({ sku }),
    body: z.object({ quantity: z.number().int().min(1).max(10000), decision: z.enum(['restock', 'damaged', 'unusable']), reason: z.string().trim().min(3).max(300) }),
  },
  async (req, res) => {
    const doc = await service.disposition(req.params.sku, req.body.quantity, req.body.decision, { type: 'manual', id: '-' }, actor(req), { reason: req.body.reason });
    await audit.record({ req, action: 'inventory.disposition', resource: { type: 'sku', id: req.params.sku }, metadata: req.body });
    ok(res, doc, { message: 'Disposition recorded' });
  },
);

api.patch(
  '/:sku/threshold',
  { summary: 'Set the low-stock alert threshold for a SKU', permission: PERMISSIONS.INVENTORY_WRITE, params: z.object({ sku }), body: z.object({ lowStockThreshold: z.number().int().min(0).max(100000).nullable() }) },
  async (req, res) => {
    const doc = await Inventory.findOneAndUpdate({ sku: req.params.sku }, { $set: { lowStockThreshold: req.body.lowStockThreshold } }, { new: true });
    if (!doc) throw notFound('SKU');
    ok(res, doc, { message: 'Threshold updated' });
  },
);

// ------------------------------------------------------------------ suppliers & purchases
const supplierBody = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  gstin: z.string().max(20).optional(),
  address: z.string().max(400).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
});

const sup = createRouter({ prefix: '/api/v1/admin/suppliers', tag: 'Admin: Inventory' });
sup.get('/', { summary: 'List suppliers', permission: PERMISSIONS.INVENTORY_READ, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(Supplier, {}, { ...req.query, sort: { name: 1 } });
  ok(res, items, { meta });
});
sup.post('/', { summary: 'Create supplier', permission: PERMISSIONS.SUPPLIERS_WRITE, body: supplierBody }, async (req, res) => {
  created(res, await Supplier.create(req.body));
});
sup.patch('/:id', { summary: 'Update supplier', permission: PERMISSIONS.SUPPLIERS_WRITE, params: z.object({ id: objectId() }), body: supplierBody.partial() }, async (req, res) => {
  const s = await Supplier.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  if (!s) throw notFound('Supplier');
  ok(res, s);
});

const pur = createRouter({ prefix: '/api/v1/admin/purchases', tag: 'Admin: Inventory' });
pur.get('/', { summary: 'List purchase receipts', permission: PERMISSIONS.INVENTORY_READ, query: paginationSchema.extend({ supplier: objectId().optional() }) }, async (req, res) => {
  const { page, limit, supplier } = req.query;
  const { items, meta } = await paginate(PurchaseRecord, supplier ? { supplier } : {}, { page, limit, populate: { path: 'supplier', select: 'name' } });
  ok(res, items, { meta });
});
pur.post(
  '/',
  {
    summary: 'Record received stock from a supplier (increments on-hand)',
    permission: PERMISSIONS.INVENTORY_WRITE,
    body: z.object({
      supplier: objectId(),
      reference: z.string().trim().min(1).max(60),
      items: z.array(z.object({ sku, quantity: z.number().int().min(1).max(100000), unitCost: z.number().int().min(0).optional() })).min(1).max(200),
      receivedAt: z.coerce.date().optional(),
      notes: z.string().max(1000).optional(),
    }),
  },
  async (req, res) => {
    if (!(await Supplier.exists({ _id: req.body.supplier }))) throw badRequest('Supplier not found');
    const record = await withTransaction(async (session) => {
      const [rec] = await PurchaseRecord.create([{ ...req.body, createdBy: req.auth.userId }], session ? { session } : {});
      await service.receivePurchase(req.body.items, { type: 'purchase', id: String(rec._id) }, actor(req), { session });
      return rec;
    });
    await audit.record({ req, action: 'inventory.purchase_receipt', resource: { type: 'purchase', id: record._id }, metadata: { reference: record.reference, lines: record.items.length } });
    created(res, record, 'Stock received');
  },
);

module.exports = { routers: [api, sup, pur] };
