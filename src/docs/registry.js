'use strict';

const { z } = require('zod');

const routes = [];

function toJsonSchema(schema) {
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' });
    delete out.$schema;
    return out;
  } catch {
    return { type: 'object' };
  }
}

function add(route) {
  routes.push(route);
}

function buildSpec({ serverUrl }) {
  const paths = {};
  for (const r of routes) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    paths[p] = paths[p] || {};
    const op = {
      tags: [r.tag],
      summary: r.summary || `${r.method.toUpperCase()} ${p}`,
      description: r.description,
      parameters: [],
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
        400: { $ref: '#/components/responses/Error' },
        401: { $ref: '#/components/responses/Error' },
        403: { $ref: '#/components/responses/Error' },
        404: { $ref: '#/components/responses/Error' },
        429: { $ref: '#/components/responses/Error' },
      },
    };
    for (const m of p.matchAll(/\{(\w+)\}/g)) op.parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    if (r.query) {
      const js = toJsonSchema(r.query);
      for (const [name, schema] of Object.entries(js.properties || {})) {
        op.parameters.push({ name, in: 'query', required: (js.required || []).includes(name), schema });
      }
    }
    if (r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(r.body) } } };
    }
    if (r.upload) {
      op.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } } },
      };
    }
    if (r.auth !== 'none' && r.auth !== undefined) op.security = [{ cookieAuth: [] }, { bearerAuth: [] }];
    if (r.permission) op.description = `${op.description ? op.description + '\n\n' : ''}Requires permission: \`${[].concat(r.permission).join(' | ')}\``;
    if (r.customer) op.description = `${op.description ? op.description + '\n\n' : ''}Customer accounts only.`;
    paths[p][r.method] = op;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Crockery Commerce API',
      version: '1.0.0',
      description:
        'Backend for a crockery, glassware, kitchenware and home-decor store.\n\n' +
        '* All money values are **integer paise** (₹1 = 100).\n' +
        '* Cookie-authenticated unsafe requests need the `X-CSRF-Token` header (from `GET /api/v1/auth/csrf`).\n' +
        '* Responses use the envelope `{ success, message, data, meta }`.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'access_token' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Envelope: {
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: {}, meta: { type: 'object' } },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            error: { type: 'object', properties: { code: { type: 'string' }, details: {} } },
            requestId: { type: 'string' },
          },
        },
      },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
    paths,
  };
}

module.exports = { add, buildSpec, routes };
