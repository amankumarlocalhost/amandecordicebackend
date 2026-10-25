'use strict';

/** Writes the generated OpenAPI document to docs/openapi.json (no database needed). */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const fs = require('fs');
const path = require('path');
const env = require('../src/config/env');
require('../src/routes').moduleRouters();
const { buildSpec } = require('../src/docs/registry');

const out = path.resolve(__dirname, '../docs/openapi.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
const spec = buildSpec({ serverUrl: env.APP_URL });
fs.writeFileSync(out, JSON.stringify(spec, null, 2));
const ops = Object.values(spec.paths).reduce((a, p) => a + Object.keys(p).length, 0);
console.log(`wrote ${out}: ${Object.keys(spec.paths).length} paths, ${ops} operations`);
process.exit(0);
