'use strict';

const ORDER_STATUS = Object.freeze({
  PENDING: 'pending', // awaiting online payment
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  RTO: 'returned_to_origin',
  CANCELLED: 'cancelled',
  RETURN_REQUESTED: 'return_requested',
  RETURNED: 'returned',
  REPLACEMENT_PROCESSING: 'replacement_processing',
  COMPLETED: 'completed',
});

const S = ORDER_STATUS;

/** Allowed order transitions. Anything not listed is rejected. */
const ORDER_TRANSITIONS = Object.freeze({
  [S.PENDING]: [S.CONFIRMED, S.CANCELLED],
  [S.CONFIRMED]: [S.PROCESSING, S.PACKED, S.CANCELLED],
  [S.PROCESSING]: [S.PACKED, S.CANCELLED],
  [S.PACKED]: [S.SHIPPED, S.CANCELLED],
  [S.SHIPPED]: [S.OUT_FOR_DELIVERY, S.DELIVERED, S.DELIVERY_FAILED, S.RTO],
  [S.OUT_FOR_DELIVERY]: [S.DELIVERED, S.DELIVERY_FAILED],
  [S.DELIVERY_FAILED]: [S.OUT_FOR_DELIVERY, S.SHIPPED, S.RTO],
  [S.RTO]: [S.CANCELLED],
  [S.DELIVERED]: [S.RETURN_REQUESTED, S.REPLACEMENT_PROCESSING, S.COMPLETED],
  [S.RETURN_REQUESTED]: [S.RETURNED, S.REPLACEMENT_PROCESSING, S.DELIVERED, S.COMPLETED],
  [S.REPLACEMENT_PROCESSING]: [S.COMPLETED, S.DELIVERED, S.RETURN_REQUESTED],
  [S.RETURNED]: [S.COMPLETED],
  [S.CANCELLED]: [],
  [S.COMPLETED]: [S.RETURN_REQUESTED, S.REPLACEMENT_PROCESSING],
});

/** Customer-initiated cancellation is allowed only before packing. */
const CUSTOMER_CANCELLABLE = [S.PENDING, S.CONFIRMED, S.PROCESSING];

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PAID: 'paid',
  FAILED: 'failed',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
  COD_DUE: 'cod_due',
  COD_COLLECTED: 'cod_collected',
  COD_NOT_COLLECTED: 'cod_not_collected',
});

const PAYMENT_METHOD = Object.freeze({ UPI: 'upi', COD: 'cod' });

const RETURN_STATUS = Object.freeze({
  REQUESTED: 'requested',
  AWAITING_REVIEW: 'awaiting_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PICKUP_SCHEDULED: 'pickup_scheduled',
  ITEM_RECEIVED: 'item_received',
  INSPECTION: 'inspection',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
});

const R = RETURN_STATUS;
const RETURN_TRANSITIONS = Object.freeze({
  [R.REQUESTED]: [R.AWAITING_REVIEW, R.APPROVED, R.REJECTED, R.CANCELLED],
  [R.AWAITING_REVIEW]: [R.APPROVED, R.REJECTED, R.CANCELLED],
  [R.APPROVED]: [R.PICKUP_SCHEDULED, R.ITEM_RECEIVED, R.RESOLVED, R.CANCELLED],
  [R.PICKUP_SCHEDULED]: [R.ITEM_RECEIVED, R.CANCELLED],
  [R.ITEM_RECEIVED]: [R.INSPECTION],
  [R.INSPECTION]: [R.RESOLVED, R.REJECTED],
  [R.RESOLVED]: [R.CLOSED],
  [R.REJECTED]: [R.CLOSED],
  [R.CLOSED]: [],
  [R.CANCELLED]: [],
});
const OPEN_RETURN_STATUSES = [R.REQUESTED, R.AWAITING_REVIEW, R.APPROVED, R.PICKUP_SCHEDULED, R.ITEM_RECEIVED, R.INSPECTION];

const RETURN_REASONS = Object.freeze({
  BROKEN_GLASS: 'arrived_broken',
  CHIPPED: 'arrived_chipped',
  SHIPPING_DAMAGE: 'damaged_in_shipping',
  WRONG_ITEM: 'incorrect_product',
  MISSING_ITEM: 'missing_item',
  WRONG_COLOR: 'wrong_color_or_pattern',
  NOT_AS_DESCRIBED: 'not_as_described',
  DEFECTIVE: 'defective',
  CHANGE_OF_MIND: 'changed_mind',
});
const DAMAGE_REASONS = [RETURN_REASONS.BROKEN_GLASS, RETURN_REASONS.CHIPPED, RETURN_REASONS.SHIPPING_DAMAGE, RETURN_REASONS.DEFECTIVE];

const REFUND_STATUS = Object.freeze({
  PENDING_APPROVAL: 'pending_approval',
  AWAITING_DESTINATION: 'awaiting_destination',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
  REJECTED: 'rejected',
});

const REPLACEMENT_STATUS = Object.freeze({
  AWAITING_STOCK: 'awaiting_stock',
  RESERVED: 'reserved',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
});

/** active = published on the storefront; inactive = unpublished; pending_review = waiting for sign-off before publishing. */
const PRODUCT_STATUS = Object.freeze({ DRAFT: 'draft', PENDING_REVIEW: 'pending_review', ACTIVE: 'active', INACTIVE: 'inactive', ARCHIVED: 'archived' });

/**
 * Catalog media lifecycle. Uploads start private in pending_review and only an approved asset has a
 * public URL. superseded = an approved asset that was replaced; kept for rollback until cleanup.
 */
const MEDIA_STATUS = Object.freeze({ PENDING_REVIEW: 'pending_review', APPROVED: 'approved', REJECTED: 'rejected', SUPERSEDED: 'superseded' });
const MEDIA_USAGES = ['product', 'category', 'collection', 'banner', 'content'];

const MATERIALS = [
  'ceramic',
  'porcelain',
  'bone_china',
  'stoneware',
  'earthenware',
  'glass',
  'borosilicate_glass',
  'crystal_glass',
  'opal_glass',
  'stainless_steel',
  'copper',
  'brass',
  'wood',
  'bamboo',
  'melamine',
  'acrylic',
  'silicone',
  'resin',
  'fabric',
  'other',
];

const PACKAGING_REQUIREMENTS = [
  'fragile_label',
  'protective_wrapping',
  'bubble_wrap',
  'multi_layer_box',
  'separate_glass_packing',
  'foam_inserts',
  'large_set_crate',
  'this_side_up',
];

module.exports = {
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  CUSTOMER_CANCELLABLE,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  RETURN_STATUS,
  RETURN_TRANSITIONS,
  OPEN_RETURN_STATUSES,
  RETURN_REASONS,
  DAMAGE_REASONS,
  REFUND_STATUS,
  REPLACEMENT_STATUS,
  PRODUCT_STATUS,
  MEDIA_STATUS,
  MEDIA_USAGES,
  MATERIALS,
  PACKAGING_REQUIREMENTS,
};
