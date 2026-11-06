'use strict';

const { z } = require('zod');
const { objectId } = require('../../utils/common');

/**
 * Editable storefront content. Every field is optional: the storefront renders its built-in design
 * for anything left empty, so content can be filled in gradually without breaking the site.
 */

/** Internal paths ("/shop?x=1") or absolute https URLs only; no javascript:, data: or protocol-relative links. */
const href = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^\/(?![\/\\])[^\s<>"']*$/.test(v) || /^https:\/\/[^\s<>"']+$/.test(v) || /^mailto:[^\s<>"']+$/.test(v) || /^tel:\+?[\d\s-]+$/.test(v), 'Use a site path like /shop or an https:// URL');

const text = (max) => z.string().trim().max(max);
const link = z.object({ label: text(40).min(1), href });

/** Image references are resolved server-side to APPROVED media (or allow-listed URLs) on save. */
const imageRef = z
  .object({ media: objectId().optional(), url: z.string().url().optional(), alt: text(160).optional() })
  .refine((i) => i.media || i.url, 'Choose an image from the media library');

const SECTION_IDS = ['hero', 'features', 'categories', 'promo', 'bestSellers', 'inspiration', 'newArrivals', 'collections', 'whyChoose', 'testimonials', 'gallery', 'newsletter', 'shopByCategory', 'spaces', 'trending'];
const ICONS = ['leaf', 'diamond', 'box', 'users', 'truck', 'shield', 'hand', 'heart', 'star', 'gift', 'sparkle'];

const homepage = z.object({
  sections: z
    .array(z.object({ id: z.enum(SECTION_IDS), enabled: z.boolean().default(true) }))
    .max(SECTION_IDS.length)
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'Each section can appear once')
    .optional(),
  hero: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      subheading: text(300),
      image: imageRef,
      imagePosition: z.string().regex(/^\d{1,3}% \d{1,3}%$|^center$/, 'Use e.g. "62% 50%"'),
      primaryCta: link,
      secondaryCta: link,
      /** Slowly scrolling brand lines under the hero. */
      brandLines: z.array(text(80).min(1)).max(8),
      /** Small "featured" card in the hero corner (desktop). */
      featured: z.object({ enabled: z.boolean(), eyebrow: text(30), title: text(60), href, linkLabel: text(30), image: imageRef }).partial(),
    })
    .partial()
    .optional(),
  /** Store promises strip; custom items replace the built-in ones (shipping/COD/returns facts still come from settings when no items are set). */
  features: z.object({ items: z.array(z.object({ icon: z.enum(ICONS).default('diamond'), title: text(40).min(1), text: text(80) })).max(6) }).partial().optional(),
  shopByCategory: z.object({ eyebrow: text(40), title: text(60), body: text(300), limit: z.number().int().min(2).max(12) }).partial().optional(),
  spaces: z.object({ eyebrow: text(40), title: text(60), caption: text(40), linkLabel: text(30), allLabel: text(30) }).partial().optional(),
  trending: z.object({ eyebrow: text(40), title: text(60), limit: z.number().int().min(4).max(20) }).partial().optional(),
  categoryCards: z
    .object({ items: z.array(z.object({ title: text(40).min(1), subtitle: text(80).optional(), href, image: imageRef, badge: text(12).optional() })).max(8) })
    .partial()
    .optional(),
  promo: z.object({ script: text(30), title: text(60), body: text(400), note: text(80), cta: link, image: imageRef }).partial().optional(),
  bestSellers: z.object({ eyebrow: text(40), title: text(60), limit: z.number().int().min(4).max(20) }).partial().optional(),
  newArrivals: z.object({ eyebrow: text(40), title: text(60), limit: z.number().int().min(4).max(20) }).partial().optional(),
  inspiration: z.object({ eyebrow: text(40), heading: text(80), body: text(400), cta: link, image: imageRef, thumbs: z.array(imageRef).max(4) }).partial().optional(),
  collections: z.object({ eyebrow: text(40), title: text(60), limit: z.number().int().min(1).max(6) }).partial().optional(),
  whyChoose: z
    .object({ eyebrow: text(40), heading: text(80), items: z.array(z.object({ icon: z.enum(ICONS).default('leaf'), title: text(60).min(1), text: text(200) })).max(6), image: imageRef })
    .partial()
    .optional(),
  testimonials: z.object({ eyebrow: text(40), title: text(60) }).partial().optional(),
  gallery: z.object({ eyebrow: text(40), heading: text(80), images: z.array(imageRef).max(12) }).partial().optional(),
  newsletter: z.object({ heading: text(60), body: text(200), image: imageRef }).partial().optional(),
  seo: z.object({ title: text(70), description: text(170) }).partial().optional(),
});

const footer = z.object({
  about: text(400).optional(),
  columns: z.array(z.object({ title: text(30).min(1), links: z.array(link).max(10) })).max(5).optional(),
  social: z.object({ instagram: href, instagramHandle: text(40), pinterest: href, facebook: href, youtube: href }).partial().optional(),
  legal: z.object({ privacy: href, terms: href }).partial().optional(),
  paymentNote: text(80).optional(),
});

const announcement = z.object({
  enabled: z.boolean().default(true),
  /** Custom messages; when empty the bar is derived from live store settings (free shipping, COD...). */
  messages: z.array(text(120).min(1)).max(5).optional(),
  link: href.optional(),
});

const navigation = z.object({
  items: z.array(z.object({ label: text(30).min(1), href, children: z.array(link).max(12).optional() })).max(8),
});

const CONTENT_KEYS = { homepage, footer, announcement, navigation };

const page = z.object({
  title: text(120).min(2),
  summary: text(300).optional(),
  /** Plain text with light markdown (## headings, - lists, blank-line paragraphs). Rendered as text, never HTML. */
  body: z.string().max(50000).optional(),
  heroImage: imageRef.nullable().optional(),
  seo: z.object({ title: text(70), description: text(170) }).partial().optional(),
});

/** Walks a content object and returns every imageRef-shaped node (objects with media or url + optional alt). */
function collectImageRefs(value, out = [], depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectImageRefs(v, out, depth + 1);
    return out;
  }
  const keys = Object.keys(value);
  if ((value.media || value.url) && keys.every((k) => ['media', 'url', 'alt', 'mediumUrl', 'thumbUrl', 'posterUrl', 'width', 'height'].includes(k))) {
    out.push(value);
    return out;
  }
  for (const k of keys) collectImageRefs(value[k], out, depth + 1);
  return out;
}

module.exports = { CONTENT_KEYS, SECTION_IDS, ICONS, page, href, imageRef, collectImageRefs };
