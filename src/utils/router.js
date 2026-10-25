'use strict';

const express = require('express');
const registry = require('../docs/registry');
const { validate } = require('../middleware/validate');
const { authenticate, optionalAuth, requireCustomer, requirePermission, requireStaff } = require('../middleware/auth');

/**
 * Declarative route builder: every route states its auth, permission and Zod schemas once,
 * which wires the middleware *and* documents the route in OpenAPI.
 *
 * opts: { summary, auth: 'none'|'optional'|'required', customer, staff, permission, params, query, body,
 *         rateLimit, upload, description }
 */
function createRouter({ prefix, tag }) {
  const router = express.Router();
  const api = { router, prefix };

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    api[method] = (path, opts, ...handlers) => {
      const chain = [];
      const needsAuth = opts.auth === 'required' || opts.customer || opts.staff || opts.permission;
      if (needsAuth) chain.push(authenticate);
      else if (opts.auth === 'optional') chain.push(optionalAuth);
      if (opts.customer) chain.push(requireCustomer);
      if (opts.staff) chain.push(requireStaff);
      if (opts.permission) chain.push(requirePermission(...[].concat(opts.permission)));
      if (opts.rateLimit) chain.push(opts.rateLimit);
      if (opts.upload) chain.push(opts.upload);
      if (opts.params || opts.query || opts.body) chain.push(validate(opts));
      router[method](path, ...chain, ...handlers);
      registry.add({
        method,
        path: `${prefix}${path === '/' ? '' : path}`,
        tag,
        ...opts,
        auth: needsAuth ? 'required' : opts.auth || 'none',
      });
    };
  }
  return api;
}

module.exports = { createRouter };
