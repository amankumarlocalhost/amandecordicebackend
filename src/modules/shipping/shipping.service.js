'use strict';

const { ServiceablePincode } = require('./shipping.models');
const { getSettings } = require('../settings/settings');
const cache = require('../../services/cache');

const pincodeRule = (pincode) => cache.wrap(cache.NS.SETTINGS, `pin:${pincode}`, 300, async () => (await ServiceablePincode.findOne({ pincode }).lean()) || null);

const GLASS = new Set(['glass', 'borosilicate_glass', 'crystal_glass', 'opal_glass']);

async function checkServiceability(pincode) {
  const settings = await getSettings();
  const rec = await pincodeRule(pincode);
  const days = rec?.estimatedDays || settings.shipping.defaultEstimatedDays;
  const serviceable = settings.shipping.pincodeMode === 'all' ? rec?.isActive !== false : Boolean(rec?.isActive);
  return {
    pincode,
    serviceable,
    codAvailable: serviceable && settings.cod.enabled && rec?.codAvailable !== false,
    estimatedDays: days,
    estimatedDeliveryDate: serviceable ? estimateDeliveryDate(days).toISOString().slice(0, 10) : null,
    extraFee: rec?.extraFee || 0,
    city: rec?.city,
    state: rec?.state,
  };
}

/** Adds working days (Sundays skipped). This is an estimate, not a courier commitment. */
function estimateDeliveryDate(days, from = new Date()) {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0) added++;
  }
  return d;
}

function lineWeights(lines, divisor) {
  let actual = 0;
  let volumetric = 0;
  for (const l of lines) {
    actual += (l.weightGrams || 0) * l.quantity;
    const d = l.dimensions || {};
    if (d.lengthMm && d.widthMm && d.heightMm) volumetric += ((d.lengthMm * d.widthMm * d.heightMm) / 1000 / divisor) * 1000 * l.quantity; // cm³/divisor kg → g
  }
  return { actualGrams: Math.round(actual), volumetricGrams: Math.round(volumetric), chargeableGrams: Math.round(Math.max(actual, volumetric)) };
}

/**
 * Shipping fee = base + per-kg over the included weight (chargeable = max(actual, volumetric))
 * + fragile surcharge + pincode surcharge. Free above the threshold or with a free-shipping offer.
 */
async function calculateShipping({ lines, merchandiseTotal, pincode, freeShipping = false }) {
  const settings = (await getSettings()).shipping;
  const weights = lineWeights(lines, settings.volumetricDivisor);
  const serviceability = pincode ? await checkServiceability(pincode) : null;
  const fragile = lines.some((l) => l.isFragile);
  const overGrams = Math.max(0, weights.chargeableGrams - settings.includedWeightGrams);
  const breakdown = {
    base: settings.baseFee,
    weight: Math.ceil(overGrams / 1000) * settings.perKgFee,
    fragile: fragile ? settings.fragileSurcharge : 0,
    pincode: serviceability?.extraFee || 0,
  };
  const gross = breakdown.base + breakdown.weight + breakdown.fragile + breakdown.pincode;
  const qualifiesFree = freeShipping || merchandiseTotal >= settings.freeShippingThreshold;
  return {
    fee: qualifiesFree ? 0 : gross,
    grossFee: gross,
    freeShippingApplied: qualifiesFree && gross > 0,
    freeShippingThreshold: settings.freeShippingThreshold,
    breakdown,
    weights,
    serviceability,
  };
}

/** Packing instructions for the warehouse, derived from the products in the parcel. */
function packagingPlan(lines) {
  const req = new Set();
  const notes = [];
  for (const l of lines) {
    for (const r of l.packaging?.requirements || []) req.add(r);
    if (l.isFragile) {
      req.add('fragile_label');
      req.add('protective_wrapping');
    }
    if (GLASS.has(l.material)) {
      req.add('separate_glass_packing');
      req.add('bubble_wrap');
    }
    if ((l.piecesPerSet || 0) >= 18) {
      req.add('large_set_crate');
      req.add('multi_layer_box');
      notes.push(`${l.name}: large set (${l.piecesPerSet} pcs) – pack in a crate with layer separators`);
    }
    if (l.packaging?.notes) notes.push(`${l.name}: ${l.packaging.notes}`);
  }
  return { requirements: [...req], notes: notes.join('\n') };
}

module.exports = { checkServiceability, calculateShipping, packagingPlan, estimateDeliveryDate, lineWeights };
