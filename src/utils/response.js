'use strict';

function ok(res, data = null, { message = 'OK', meta, status = 200 } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

function created(res, data, message = 'Created') {
  return ok(res, data, { message, status: 201 });
}

module.exports = { ok, created };
