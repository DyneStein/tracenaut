import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const withTraceNaut = require('../../packages/next-plugin/dist/index.cjs');

test('the app\'s Content-Security-Policy lets the local TraceNaut client, icons and API through (dev only)', async () => {
  const csp = "default-src 'self'; img-src 'self' https: data:; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'self';";
  const config = withTraceNaut({ headers: async () => [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' }] }] });
  const [rule] = await config.headers();
  const value = rule.headers[0].value;
  for (const d of ['img-src', 'script-src', 'connect-src']) assert.match(value, new RegExp(`${d} [^;]*http://127\\.0\\.0\\.1:\\*`));
  assert.match(value, /frame-ancestors 'self';$/);
  assert.equal(rule.headers[1].value, 'DENY');
  // Only default-src: the needed directives are added from it.
  assert.equal(withTraceNaut.allowTraceNaut("default-src 'self'"), "default-src 'self'; script-src 'self' http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; img-src 'self' http://127.0.0.1:*;");
});

test('Turbopack rules cover only the project\'s own files, and webpack gets a pre-loader', () => {
  const config = withTraceNaut({});
  const tsx = config.turbopack.rules['*.tsx'];
  // Next 15 syntax ({ foreign: false, default }) or Next 16 syntax ({ condition: { not: 'foreign' } }).
  assert.ok(tsx.foreign === false || tsx.condition?.not === 'foreign', JSON.stringify(tsx));
  const webpack = config.webpack({ module: { rules: [] } }, { dev: true, isServer: false });
  assert.equal(webpack.module.rules[0].enforce, 'pre');
  assert.equal(config.webpack({ module: { rules: [] } }, { dev: false, isServer: false }).module.rules.length, 0);
});
