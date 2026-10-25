'use strict';

/** Collects every module router. Order matters only for overlapping paths (none today). */
function moduleRouters() {
  const list = [
    require('../modules/auth/auth.routes').router,
    ...require('../modules/users/users.routes').routers,
    require('../modules/addresses/addresses.routes').router,
    ...require('../modules/categories/categories.routes').routers,
    ...require('../modules/collections/collections.routes').routers,
    ...require('../modules/products/products.routes').routers,
    require('../modules/media/media').router,
    ...require('../modules/content/content.routes').routers,
    ...require('../modules/inventory/inventory.routes').routers,
    ...require('../modules/promotions/promotions.routes').routers,
    ...require('../modules/cart/cart.routes').routers,
    ...require('../modules/shipping/shipping.routes').routers,
    require('../modules/checkout/checkout.routes').router,
    ...require('../modules/orders/orders.routes').routers,
    ...require('../modules/payments/payments.routes').routers,
    ...require('../modules/refunds/refunds.routes').routers,
    ...require('../modules/returns/returns.routes').routers,
    ...require('../modules/replacements/replacements.routes').routers,
    ...require('../modules/reviews/reviews.routes').routers,
    ...require('../modules/notifications/notifications.routes').routers,
    ...require('../modules/chat/chat.routes').routers,
    ...require('../modules/ai/ai.routes').routers,
    ...require('../modules/analytics/analytics.routes').routers,
    ...require('../modules/admin/admin.routes').routers,
    require('../modules/settings/settings').router,
    require('../modules/audit/audit').router,
  ];
  return list;
}

module.exports = { moduleRouters };
