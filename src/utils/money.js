'use strict';

/**
 * Money policy: every amount is an integer number of paise (INR minor unit).
 * Rounding is half-up on non-negative values (Math.round). Selling prices are GST-inclusive,
 * so tax is extracted from the gross line amount rather than added on top.
 */

const CURRENCY = 'INR';

function assertPaise(value, name = 'amount') {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer (paise)`);
  return value;
}

/** Percentage expressed in basis points (1% = 100 bps). */
function bpsOf(amount, bps) {
  return Math.round((amount * bps) / 10000);
}

/** Tax contained in a GST-inclusive gross amount. */
function inclusiveTax(gross, rateBps) {
  if (!rateBps) return 0;
  return Math.round((gross * rateBps) / (10000 + rateBps));
}

/**
 * Split `total` across `weights` proportionally using the largest-remainder method so
 * the parts always sum exactly to `total`.
 */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) floors[order[k][1]] += 1;
  return floors;
}

function formatINR(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { CURRENCY, assertPaise, bpsOf, inclusiveTax, allocate, formatINR };
