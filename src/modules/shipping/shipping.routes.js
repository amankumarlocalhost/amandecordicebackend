'use strict';

const { z } = require('zod');
const service = require('./shipping.service');
const { ServiceablePincode, Shipment } = require('./shipping.models');
const { getCourier, adapters } = require('./couriers');
const Order = require('../orders/order.model');
const orderService = require('../orders/order.service');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const { transaction } = require('../../config/database');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, conflict } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { ORDER_STATUS: S } = require('../../constants/statuses');

const pincode = z.string().regex(/^[1-9]\d{5}$/, 'Invalid PIN code');

const pub = createRouter({ prefix: '/api/v1/shipping', tag: 'Shipping' });
pub.get('/serviceability/:pincode', { summary: 'Delivery and COD availability for a PIN code', params: z.object({ pincode }) }, async (req, res) => {
  ok(res, await service.checkServiceability(req.params.pincode));
});

const admin = createRouter({ prefix: '/api/v1/admin', tag: 'Admin: Shipping' });

admin.get('/pincodes', { summary: 'Serviceable PIN codes', permission: PERMISSIONS.ORDERS_READ, query: paginationSchema.extend({ pincode: z.string().max(6).optional() }) }, async (req, res) => {
  const { page, limit, pincode: p } = req.query;
  const { items, meta } = await paginate(ServiceablePincode, p ? { pincode: new RegExp(`^${p.replace(/\D/g, '')}`) } : {}, { page, limit, sort: { pincode: 1 } });
  ok(res, items, { meta });
});

admin.put(
  '/pincodes',
  {
    summary: 'Bulk upsert PIN code rules (up to 1000)',
    permission: PERMISSIONS.SETTINGS_WRITE,
    body: z.object({
      items: z
        .array(z.object({ pincode, city: z.string().max(80).optional(), state: z.string().max(80).optional(), zone: z.string().max(30).optional(), isActive: z.boolean().default(true), codAvailable: z.boolean().default(true), estimatedDays: z.number().int().min(1).max(30).optional(), extraFee: z.number().int().min(0).default(0) }))
        .min(1)
        .max(1000),
    }),
  },
  async (req, res) => {
    const ops = req.body.items.map((i) => ({ updateOne: { filter: { pincode: i.pincode }, update: { $set: i }, upsert: true } }));
    const r = await ServiceablePincode.bulkWrite(ops, { ordered: false });
    const cache = require('../../services/cache');
    await cache.bump(cache.NS.SETTINGS);
    await audit.record({ req, action: 'shipping.pincodes_upsert', resource: { type: 'pincodes', id: 'bulk' }, metadata: { count: ops.length } });
    ok(res, { upserted: r.upsertedCount, modified: r.modifiedCount }, { message: 'PIN codes updated' });
  },
);

admin.get('/couriers', { summary: 'Available courier adapters', permission: PERMISSIONS.ORDERS_READ }, (req, res) => {
  ok(res, Object.values(adapters).map((a) => ({ name: a.name, supportsTracking: a.supportsTracking })));
});

admin.post(
  '/orders/:id/shipments',
  {
    summary: 'Create the forward shipment (AWB) and mark the order shipped',
    permission: PERMISSIONS.SHIPMENTS_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({
      courier: z.string().max(40).default('manual'),
      awb: z.string().trim().min(4).max(40),
      trackingUrl: z.string().url().optional(),
      packages: z.array(z.object({ weightGrams: z.number().min(0), lengthMm: z.number().min(0).optional(), widthMm: z.number().min(0).optional(), heightMm: z.number().min(0).optional(), contents: z.array(z.string().max(80)).max(50).optional() })).max(20).optional(),
    }),
  },
  async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw notFound('Order');
    if (order.status !== S.PACKED) throw conflict('Pack the order before creating its shipment', 'INVALID_STATE');
    const courier = getCourier(req.body.courier);
    const booking = await courier.createShipment({ order, shipment: req.body });
    const actor = { type: 'staff', id: req.auth.userId };
    const shipment = await transaction(async (ctx) => {
      const [s] = await Shipment.create(
        [{ order: order._id, kind: 'forward', courier: courier.name, awb: booking.awb || req.body.awb, trackingUrl: booking.trackingUrl || req.body.trackingUrl, packages: req.body.packages, packaging: order.packaging, events: [{ status: 'created', note: 'Shipment created' }], createdBy: req.auth.userId }],
        { session: ctx.session },
      );
      await Order.updateOne({ _id: order._id }, { $set: { shipment: s._id } }, { session: ctx.session });
      await orderService.transition(order, S.SHIPPED, { actor, note: `AWB ${s.awb}`, ctx });
      return s;
    });
    await audit.record({ req, action: 'shipment.create', resource: { type: 'order', id: order._id }, metadata: { awb: shipment.awb, courier: shipment.courier } });
    created(res, shipment, 'Shipment created');
  },
);

const SHIPMENT_TO_ORDER = { out_for_delivery: S.OUT_FOR_DELIVERY, delivered: S.DELIVERED, failed_attempt: S.DELIVERY_FAILED, rto_initiated: S.RTO };

admin.post(
  '/shipments/:id/events',
  {
    summary: 'Record a tracking event (drives order status: out for delivery, delivered, failed attempt, RTO)',
    permission: PERMISSIONS.SHIPMENTS_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({
      status: z.enum(['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed_attempt', 'rto_initiated', 'rto_delivered']),
      location: z.string().max(100).optional(),
      note: z.string().max(300).optional(),
      proofOfDelivery: z.object({ receiverName: z.string().max(100), otpVerified: z.boolean(), photoUrl: z.string().url() }).partial().optional(),
    }),
  },
  async (req, res) => {
    const shipment = await Shipment.findById(req.params.id);
    if (!shipment) throw notFound('Shipment');
    const actor = { type: 'staff', id: req.auth.userId };
    const { status, location, note, proofOfDelivery } = req.body;
    shipment.events.push({ status, location, note });
    shipment.status = status;
    if (status === 'delivered') {
      shipment.deliveredAt = new Date();
      if (proofOfDelivery) shipment.proofOfDelivery = proofOfDelivery;
    }
    if (status === 'failed_attempt') shipment.failedAttempts += 1;
    await shipment.save();

    if (shipment.kind === 'forward' && shipment.order && SHIPMENT_TO_ORDER[status]) {
      const order = await Order.findById(shipment.order);
      const target = SHIPMENT_TO_ORDER[status];
      if (order.status !== target && orderService.canTransition(order.status, target)) {
        await orderService.transition(order, target, { actor, note: note || `Courier: ${status}` });
      }
    }
    if (shipment.kind === 'replacement' && shipment.replacement) {
      const { syncReplacementShipment } = require('../replacements/replacement.service');
      await syncReplacementShipment(shipment, actor);
    }
    bus.publish(bus.EVENTS.SHIPMENT_UPDATED, { shipmentId: shipment._id, orderId: shipment.order, status });
    await audit.record({ req, action: 'shipment.event', resource: { type: 'shipment', id: shipment._id }, metadata: { status } });
    ok(res, shipment, { message: 'Tracking updated' });
  },
);

module.exports = { routers: [pub, admin] };
