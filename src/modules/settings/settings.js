'use strict';

const mongoose = require('mongoose');
const { z } = require('zod');
const cache = require('../../services/cache');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { badRequest } = require('../../utils/errors');
const { PERMISSIONS } = require('../../constants/roles');

const paise = () => z.number().int().min(0);

/** Every section is a Zod schema whose defaults are the out-of-the-box business policy. */
const SECTIONS = {
  store: z.object({
    name: z.string().max(100).default('Decor Dice'),
    supportEmail: z.string().max(254).default('support@example.com'),
    supportPhone: z.string().max(20).default(''),
    gstin: z.string().max(20).default(''),
    timezone: z.string().default('Asia/Kolkata'),
    pickupPincode: z.string().max(10).default(''),
  }),
  checkout: z.object({
    reservationMinutes: z.number().int().min(5).max(120).default(15),
    maxQuantityPerItem: z.number().int().min(1).max(500).default(20),
    maxLinesPerOrder: z.number().int().min(1).max(200).default(50),
    allowGuestCart: z.boolean().default(true),
  }),
  tax: z.object({
    defaultGstRateBps: z.number().int().min(0).max(2800).default(1800),
    pricesIncludeTax: z.literal(true).default(true),
  }),
  shipping: z.object({
    pincodeMode: z.enum(['all', 'allowlist']).default('all'),
    baseFee: paise().default(4900),
    freeShippingThreshold: paise().default(99900),
    includedWeightGrams: z.number().int().min(0).default(1000),
    perKgFee: paise().default(2500),
    fragileSurcharge: paise().default(3000),
    volumetricDivisor: z.number().int().min(1000).max(10000).default(5000),
    defaultEstimatedDays: z.number().int().min(1).max(30).default(5),
  }),
  cod: z.object({
    enabled: z.boolean().default(true),
    fee: paise().default(4900),
    minOrderValue: paise().default(0),
    maxOrderValue: paise().default(1000000),
    requireVerifiedPhone: z.boolean().default(true),
  }),
  upi: z.object({
    enabled: z.boolean().default(true),
  }),
  returns: z.object({
    defaultWindowDays: z.number().int().min(0).max(60).default(7),
    damageReportWindowDays: z.number().int().min(0).max(30).default(3),
    allowChangeOfMind: z.boolean().default(false),
    requirePhotosForDamage: z.boolean().default(true),
    autoApproveEnabled: z.boolean().default(true),
    autoApproveMaxValue: paise().default(200000),
    maxClaimsPer90Days: z.number().int().min(0).default(3),
    pickupRequiredForDamage: z.boolean().default(false),
    pickupRequiredForReturn: z.boolean().default(true),
  }),
  refunds: z.object({
    limitedApprovalMax: paise().default(500000),
    autoRefundOnCancellation: z.boolean().default(true),
  }),
  giftWrap: z.object({
    enabled: z.boolean().default(true),
    fee: paise().default(4900),
  }),
  ai: z.object({
    customerEnabled: z.boolean().default(true),
    adminEnabled: z.boolean().default(true),
    customerDailyLimit: z.number().int().min(0).default(60),
    adminDailyLimit: z.number().int().min(0).default(400),
    maxHistoryMessages: z.number().int().min(4).max(60).default(16),
  }),
  inventory: z.object({
    defaultLowStockThreshold: z.number().int().min(0).default(5),
  }),
};

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    ...Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, { type: mongoose.Schema.Types.Mixed, default: {} }])),
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false },
);
const BusinessSettings = mongoose.model('BusinessSettings', settingsSchema);

function withDefaults(doc = {}) {
  const out = {};
  for (const [name, schema] of Object.entries(SECTIONS)) out[name] = schema.parse(doc[name] || {});
  return out;
}

async function getSettings() {
  return cache.wrap(cache.NS.SETTINGS, 'global', 30, async () => {
    const doc = await BusinessSettings.findOne({ key: 'global' }).lean();
    return withDefaults(doc || {});
  });
}

async function updateSection(section, patch, req) {
  const schema = SECTIONS[section];
  if (!schema) throw badRequest(`Unknown settings section "${section}"`);
  const current = (await getSettings())[section];
  const next = schema.strict().parse({ ...current, ...patch });
  await BusinessSettings.updateOne(
    { key: 'global' },
    { $set: { [section]: next, updatedBy: req?.auth?.userId } },
    { upsert: true },
  );
  await cache.bump(cache.NS.SETTINGS);
  if (PUBLIC_SECTIONS.includes(section)) {
    const sync = require('../../services/sync');
    sync.changed({ tags: [sync.TAGS.SETTINGS], events: [{ event: sync.EVENTS.CONTENT_UPDATED, key: 'settings' }] });
  }
  await audit.record({ req, action: 'settings.update', resource: { type: 'settings', id: section }, metadata: { before: current, after: next } });
  return next;
}

const PUBLIC_SECTIONS = ['store', 'checkout', 'shipping', 'cod', 'upi', 'returns', 'giftWrap'];

const api = createRouter({ prefix: '/api/v1', tag: 'Settings' });

api.get('/settings/public', { summary: 'Public store policies (shipping, COD, returns, gift wrap)' }, async (req, res) => {
  const s = await getSettings();
  const out = Object.fromEntries(PUBLIC_SECTIONS.map((k) => [k, s[k]]));
  delete out.returns.autoApproveMaxValue;
  delete out.returns.maxClaimsPer90Days;
  delete out.returns.autoApproveEnabled;
  ok(res, out);
});

api.get('/admin/settings', { summary: 'All business settings', permission: [PERMISSIONS.SETTINGS_WRITE, PERMISSIONS.AI_SETTINGS] }, async (req, res) => {
  ok(res, await getSettings());
});

api.patch(
  '/admin/settings/:section',
  {
    summary: 'Update one settings section (store, checkout, tax, shipping, cod, upi, returns, refunds, giftWrap, ai, inventory)',
    permission: [PERMISSIONS.SETTINGS_WRITE, PERMISSIONS.AI_SETTINGS],
    params: z.object({ section: z.enum(Object.keys(SECTIONS)) }),
    body: z.record(z.string(), z.any()),
  },
  async (req, res) => {
    const { section } = req.params;
    const canAll = req.auth.permissions.includes(PERMISSIONS.SETTINGS_WRITE);
    if (!canAll && section !== 'ai') throw badRequest('You may only change AI settings');
    ok(res, await updateSection(section, req.body, req), { message: 'Settings updated' });
  },
);

module.exports = { BusinessSettings, SECTIONS, getSettings, updateSection, withDefaults, router: api };
