'use strict';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Validates and replaces req.params / req.query / req.body with parsed Zod output.
 * For PATCH requests only the top-level keys the client actually sent are kept, so schema
 * defaults never silently overwrite stored values during partial updates.
 */
function validate({ params, query, body }) {
  return (req, res, next) => {
    if (params) req.params = params.parse(req.params);
    if (query) {
      const parsed = query.parse(req.query);
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true, enumerable: true });
    }
    if (body) {
      const raw = req.body ?? {};
      let parsed = body.parse(raw);
      if (req.method === 'PATCH' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && raw && typeof raw === 'object') {
        parsed = Object.fromEntries(Object.entries(parsed).filter(([k]) => hasOwn(raw, k)));
      }
      req.body = parsed;
    }
    next();
  };
}

module.exports = { validate };
