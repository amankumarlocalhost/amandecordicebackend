'use strict';

const { z } = require('zod');
const service = require('./checkout.service');
const pricing = require('../pricing/pricing.service');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { badRequest } = require('../../utils/errors');
const { objectId } = require('../../utils/common');
const { limits } = require('../../middleware/rateLimit');

const api = createRouter({ prefix: '/api/v1/checkout', tag: 'Checkout' });

api.post(
  '/quote',
  {
    summary: 'Price the cart for an address and payment method (UPI or COD) without placing an order',
    customer: true,
    body: z.object({ addressId: objectId(), paymentMethod: z.enum(['upi', 'cod']).optional() }),
  },
  async (req, res) => {
    const { q } = await service.quoteForCheckout(req.auth.userId, req.body);
    ok(res, pricing.publicQuote(q));
  },
);

api.post(
  '/place-order',
  {
    summary: 'Place an order from the cart. Requires an Idempotency-Key header (UUID). Only "upi" and "cod" are accepted.',
    description:
      'Send `expectedTotal` (the total shown to the customer) to be protected from stale prices. For UPI, the response contains Razorpay Checkout options restricted to UPI; the order is confirmed only after server-side verification (POST /payments/razorpay/verify or webhook).',
    customer: true,
    rateLimit: limits.checkout,
    body: z.object({
      addressId: objectId(),
      paymentMethod: z.enum(['upi', 'cod']),
      expectedTotal: z.number().int().min(0).optional(),
      giftMessage: z.string().trim().max(300).optional(),
    }),
  },
  async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !/^[\w-]{16,64}$/.test(key)) throw badRequest('Idempotency-Key header (16–64 chars) is required', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
    const result = await service.placeOrder(req.auth.userId, { ...req.body, idempotencyKey: key }, req);
    if (result.duplicate) return ok(res, result, { message: 'Order already placed' });
    created(res, result, result.order.paymentMethod === 'cod' ? 'Order confirmed' : 'Order created. Complete the UPI payment.');
  },
);

module.exports = { router: api };
