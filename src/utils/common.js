'use strict';

const mongoose = require('mongoose');
const { z } = require('zod');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const isObjectId = (v) => mongoose.isValidObjectId(v) && String(new mongoose.Types.ObjectId(String(v))) === String(v);
const objectId = () => z.string().refine(isObjectId, 'Invalid id');
const toId = (v) => (v ? String(v._id || v) : null);

/** Pagination with hard upper bound. */
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function pageMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

async function paginate(Model, filter, { page, limit, sort = { createdAt: -1 }, select, populate, lean = true }) {
  let q = Model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, Model.countDocuments(filter)]);
  return { items, meta: pageMeta(page, limit, total) };
}

const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function dateFilter(from, to) {
  if (!from && !to) return undefined;
  const f = {};
  if (from) f.$gte = from;
  if (to) f.$lte = to;
  return f;
}

/** Normalises Indian phone numbers to E.164 (+91XXXXXXXXXX). */
function normalizePhone(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  const d = digits.replace(/^\+/, '');
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `+91${d.slice(1)}`;
  return null;
}

const phoneSchema = z
  .string()
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
    return p;
  });

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

function maskPhone(p) {
  return p ? p.replace(/^(\+\d{2})\d+(\d{3})$/, '$1*****$2') : p;
}
function maskEmail(e) {
  if (!e) return e;
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}***@${d}`;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400000);
const addMinutes = (date, m) => new Date(new Date(date).getTime() + m * 60000);

module.exports = {
  escapeRegex,
  slugify,
  isObjectId,
  objectId,
  toId,
  paginationSchema,
  pageMeta,
  paginate,
  dateRangeSchema,
  dateFilter,
  normalizePhone,
  phoneSchema,
  emailSchema,
  maskPhone,
  maskEmail,
  pick,
  addDays,
  addMinutes,
};
