'use strict';

const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  SUPER_ADMIN: 'super_admin',
  CATALOG_MANAGER: 'catalog_manager',
  INVENTORY_MANAGER: 'inventory_manager',
  ORDER_MANAGER: 'order_manager',
  SUPPORT_AGENT: 'support_agent',
  MARKETING_MANAGER: 'marketing_manager',
  ANALYST: 'analyst',
});

const STAFF_ROLES = Object.values(ROLES).filter((r) => r !== ROLES.CUSTOMER);

/**
 * Permission catalogue. Permissions are coarse on purpose: each maps to a business capability,
 * and every admin route / admin-AI tool names exactly one.
 */
const PERMISSIONS = Object.freeze({
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',
  CATALOG_COST: 'catalog:cost', // view/edit cost price
  MEDIA_REVIEW: 'media:review', // approve/reject uploaded catalog media
  CONTENT_WRITE: 'content:write', // homepage, footer, informational pages
  PRICING_WRITE: 'pricing:write',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  SUPPLIERS_WRITE: 'suppliers:write',
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',
  SHIPMENTS_WRITE: 'shipments:write',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_COD: 'payments:cod',
  REFUNDS_REQUEST: 'refunds:request',
  REFUNDS_APPROVE_LIMITED: 'refunds:approve_limited',
  REFUNDS_APPROVE: 'refunds:approve',
  RETURNS_READ: 'returns:read',
  RETURNS_WRITE: 'returns:write',
  PROMOTIONS_READ: 'promotions:read',
  PROMOTIONS_WRITE: 'promotions:write',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  SUPPORT_READ: 'support:read',
  SUPPORT_WRITE: 'support:write',
  REVIEWS_MODERATE: 'reviews:moderate',
  REPORTS_SALES: 'reports:sales',
  REPORTS_FINANCIAL: 'reports:financial',
  REPORTS_INVENTORY: 'reports:inventory',
  REPORTS_CUSTOMERS: 'reports:customers',
  NOTIFICATIONS_MANAGE: 'notifications:manage',
  SETTINGS_WRITE: 'settings:write',
  STAFF_MANAGE: 'staff:manage',
  AUDIT_READ: 'audit:read',
  AI_ADMIN: 'ai:admin',
  AI_SETTINGS: 'ai:settings',
  JOBS_MANAGE: 'jobs:manage',
});

const P = PERMISSIONS;

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.CUSTOMER]: [],
  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),
  [ROLES.CATALOG_MANAGER]: [P.CATALOG_READ, P.CATALOG_WRITE, P.PRICING_WRITE, P.INVENTORY_READ, P.REVIEWS_MODERATE, P.PROMOTIONS_READ, P.MEDIA_REVIEW, P.CONTENT_WRITE, P.AI_ADMIN],
  [ROLES.INVENTORY_MANAGER]: [
    P.CATALOG_READ,
    P.INVENTORY_READ,
    P.INVENTORY_WRITE,
    P.SUPPLIERS_WRITE,
    P.CATALOG_COST,
    P.RETURNS_READ,
    P.REPORTS_INVENTORY,
    P.AI_ADMIN,
  ],
  [ROLES.ORDER_MANAGER]: [
    P.CATALOG_READ,
    P.INVENTORY_READ,
    P.ORDERS_READ,
    P.ORDERS_WRITE,
    P.SHIPMENTS_WRITE,
    P.PAYMENTS_READ,
    P.PAYMENTS_COD,
    P.REFUNDS_REQUEST,
    P.REFUNDS_APPROVE_LIMITED,
    P.RETURNS_READ,
    P.RETURNS_WRITE,
    P.CUSTOMERS_READ,
    P.SUPPORT_READ,
    P.AI_ADMIN,
  ],
  [ROLES.SUPPORT_AGENT]: [
    P.CATALOG_READ,
    P.ORDERS_READ,
    P.RETURNS_READ,
    P.RETURNS_WRITE,
    P.REFUNDS_REQUEST,
    P.CUSTOMERS_READ,
    P.SUPPORT_READ,
    P.SUPPORT_WRITE,
    P.AI_ADMIN,
  ],
  [ROLES.MARKETING_MANAGER]: [
    P.CATALOG_READ,
    P.PROMOTIONS_READ,
    P.PROMOTIONS_WRITE,
    P.REPORTS_SALES,
    P.NOTIFICATIONS_MANAGE,
    P.CONTENT_WRITE,
    P.AI_ADMIN,
  ],
  [ROLES.ANALYST]: [
    P.CATALOG_READ,
    P.INVENTORY_READ,
    P.ORDERS_READ,
    P.RETURNS_READ,
    P.PROMOTIONS_READ,
    P.REPORTS_SALES,
    P.REPORTS_INVENTORY,
    P.REPORTS_CUSTOMERS,
    P.AI_ADMIN,
  ],
});

const permissionsFor = (role) => ROLE_PERMISSIONS[role] || [];
const hasPermission = (role, permission) => permissionsFor(role).includes(permission);

module.exports = { ROLES, STAFF_ROLES, PERMISSIONS, ROLE_PERMISSIONS, permissionsFor, hasPermission };
