'use strict';

const { z } = require('zod');
const { objectId, paginationSchema } = require('../../utils/common');
const { MATERIALS, PACKAGING_REQUIREMENTS, PRODUCT_STATUS } = require('../../constants/statuses');

const paise = z.number().int().min(0);
const dims = z.object({ lengthMm: z.number().min(0), widthMm: z.number().min(0), heightMm: z.number().min(0), diameterMm: z.number().min(0) }).partial();
const triState = z.boolean().nullable();

const variant = z.object({
  _id: objectId().optional(),
  sku: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/, 'SKU may contain letters, digits, - and _'),
  barcode: z.string().trim().max(64).optional(),
  title: z.string().trim().max(120).optional(),
  attributes: z
    .object({
      color: z.string().trim().max(40),
      pattern: z.string().trim().max(60),
      capacityMl: z.number().min(0),
      setSize: z.number().int().min(1),
      size: z.string().trim().max(40),
    })
    .partial()
    .optional(),
  mrp: paise.min(1),
  price: paise.min(1),
  costPrice: paise.optional(),
  weightGrams: z.number().min(0).optional(),
  dimensions: dims.optional(),
  images: z.array(z.string().url()).max(10).optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/** Gallery input: an uploaded media id (preferred) or, for allow-listed hosts only, an external URL. */
const imageInput = z
  .object({
    _id: objectId().optional(),
    media: objectId().optional(),
    url: z.string().url().optional(),
    key: z.string().optional(),
    thumbUrl: z.string().url().optional(),
    mediumUrl: z.string().url().optional(),
    alt: z.string().max(160).optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((i) => i.media || i.url, 'Each image needs a media id or url');

const videoInput = z
  .object({
    media: objectId().optional(),
    url: z.string().url().optional(),
    key: z.string().optional(),
    posterUrl: z.string().url().optional(),
    thumbUrl: z.string().url().optional(),
    durationSec: z.number().min(0).optional(),
    title: z.string().max(120).optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => v.media || v.url, 'Each video needs a media id or url');

const productBase = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).max(120).optional(),
  type: z.enum(['simple', 'bundle']).default('simple'),
  description: z.string().max(10000).optional(),
  highlights: z.array(z.string().max(200)).max(12).optional(),
  category: objectId(),
  brand: z.string().trim().max(80).optional(),
  collections: z.array(objectId()).max(20).optional(),
  tags: z.array(z.string().trim().toLowerCase().max(40)).max(30).optional(),
  images: z.array(imageInput).max(15).optional(),
  videos: z.array(videoInput).max(5).optional(),
  variants: z.array(variant).min(1).max(100),
  bundleItems: z.array(z.object({ product: objectId(), sku: z.string().trim().toUpperCase(), quantity: z.number().int().min(1).max(100) })).max(30).optional(),
  specs: z
    .object({
      material: z.enum(MATERIALS),
      materials: z.array(z.enum(MATERIALS)).max(5),
      color: z.string().max(40),
      pattern: z.string().max(60),
      finish: z.string().max(60),
      design: z.string().max(80),
      capacityMl: z.number().min(0),
      dimensions: dims,
      weightGrams: z.number().min(0),
      piecesPerSet: z.number().int().min(1),
      serves: z.number().int().min(1),
      setComposition: z.array(z.object({ item: z.string().max(60), count: z.number().int().min(1) })).max(20),
    })
    .partial()
    .optional(),
  care: z
    .object({ foodSafe: triState, dishwasherSafe: triState, microwaveSafe: triState, ovenSafe: triState, freezerSafe: triState, notes: z.string().max(1000) })
    .partial()
    .optional(),
  manufacturer: z.object({ name: z.string().max(120), address: z.string().max(300), countryOfOrigin: z.string().max(60) }).partial().optional(),
  supplier: objectId().optional(),
  isFragile: z.boolean().optional(),
  packaging: z.object({ requirements: z.array(z.enum(PACKAGING_REQUIREMENTS)).max(10), notes: z.string().max(500) }).partial().optional(),
  giftWrapAvailable: z.boolean().optional(),
  returnPolicy: z.object({ returnable: z.boolean(), windowDays: z.number().int().min(0).max(60), replacementOnly: z.boolean(), notes: z.string().max(500) }).partial().optional(),
  tax: z.object({ hsnCode: z.string().max(10), gstRateBps: z.number().int().min(0).max(2800) }).partial().optional(),
  seo: z.object({ title: z.string().max(70), description: z.string().max(170), keywords: z.array(z.string().max(40)).max(15) }).partial().optional(),
  flags: z.object({ featured: z.boolean(), bestseller: z.boolean(), newArrival: z.boolean() }).partial().optional(),
  status: z.enum(Object.values(PRODUCT_STATUS)).optional(),
});

const createProduct = productBase;
/** expectedUpdatedAt (optional): the updatedAt the editor loaded; a newer stored version is a 409 instead of a silent overwrite. */
const updateProduct = productBase.partial().extend({ expectedUpdatedAt: z.coerce.date().optional() });

const csv = (max = 10) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : [].concat(v).flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, max)));

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(120).optional(), // id or slug
  collection: z.string().trim().max(120).optional(),
  brand: csv(),
  material: csv(),
  color: csv(),
  pattern: csv(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  minCapacityMl: z.coerce.number().min(0).optional(),
  maxCapacityMl: z.coerce.number().min(0).optional(),
  setSize: z.coerce.number().int().min(1).optional(),
  minPieces: z.coerce.number().int().min(1).optional(),
  serves: z.coerce.number().int().min(1).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  featured: z.enum(['true']).optional(),
  bestseller: z.enum(['true']).optional(),
  newArrival: z.enum(['true']).optional(),
  discounted: z.enum(['true']).optional(),
  microwaveSafe: z.enum(['true']).optional(),
  dishwasherSafe: z.enum(['true']).optional(),
  giftWrap: z.enum(['true']).optional(),
  type: z.enum(['simple', 'bundle']).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest', 'popularity', 'rating', 'discount']).default('relevance'),
});

module.exports = { createProduct, updateProduct, listQuery, variant, imageInput, videoInput };
