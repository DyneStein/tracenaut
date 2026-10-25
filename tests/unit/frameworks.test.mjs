import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { Analyzer, loadWorkspace } from '../../packages/daemon/dist/analysis.js';

// Small hand-written projects using each framework; their packages are not installed,
// as in a fresh checkout, so recognition must not depend on library types.
const a = new Analyzer(loadWorkspace('tests/fixtures/frameworks'));
const routes = a.allRoutes().map((r) => ({ fw: r.framework, route: `${r.method} ${r.path}`, mw: r.middleware.map((m) => m.expr.getText()) }));
const has = (fw, route) => routes.find((r) => r.fw === fw && r.route === route);

test('Fastify: direct routes, route({ … }) and register(plugin, { prefix })', () => {
  assert.ok(has('fastify', 'GET /health'));
  assert.deepEqual(has('fastify', 'GET /version').mw, ['auth']);
  assert.ok(has('fastify', 'HEAD /version'));
  assert.ok(has('fastify', 'GET /v1/users/:id'), 'routes on the plugin parameter get the register() prefix');
  assert.ok(has('fastify', 'POST /v1/users'));
});

test('Hono: sub-apps mounted with route(), path middleware with use("/x/*")', () => {
  assert.deepEqual(has('hono', 'GET /books/:id').mw, ['logger']);
  assert.ok(has('hono', 'DELETE /books/:id'));
});

test('koa-router: constructor prefix and nested routers; a look-alike local class is ignored', () => {
  assert.ok(has('koa-router', 'GET /shop/cart'));
  assert.ok(has('koa-router', 'GET /shop/orders/:orderId'));
  assert.equal(routes.some((r) => r.route.includes('/ignored')), false);
});

test('Next.js: app router folders (groups dropped, [id] → :id) and pages/api', () => {
  for (const r of ['GET /api/items/:id', 'DELETE /api/items/:id', 'POST /api/items', 'GET /api/stats', 'ALL /api/legacy']) assert.ok(has('next', r), r);
  assert.equal(routes.some((r) => r.route.includes('dynamic')), false, 'non-method exports are not routes');
});

const requests = () => {
  const sf = a.project('next').sourceFile('next/lib/client.ts');
  const out = {};
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const r = a.outgoing(st).find((x) => x.kind === 'requests');
    if (r) out[st.name.text] = { label: r.target.label, evidence: r.evidence, d: a.requestDetails(r.target.id), routes: a.flowRelations(r.target.id) };
  }
  return out;
};

test('requests compose through several wrapper layers and URL builders', () => {
  const r = requests();
  assert.equal(r.loadItem.label, 'GET {base URL}/api/items/{id}?…');
  assert.deepEqual(r.loadItem.d.chain, ['httpGet', 'request']);
  assert.equal(r.loadItem.d.shape, 'prefixed');
  assert.equal(r.loadItem.routes[0].target.label, 'GET /api/items/:id');
  assert.equal(r.loadItem.routes[0].evidence, 'inferred');
  assert.match(r.loadItem.routes[0].note, /assuming the unknown base address/);
  assert.deepEqual(r.addItem.d.bodyKeys, ['title']);
  assert.equal(r.addItem.d.format, 'JSON');
  // The generic wrappers themselves stay unresolved: their URL is whatever the caller passes.
  assert.equal(r.httpGet.evidence, 'unresolved');
});

test('axios: instances with baseURL, shorthand methods and config calls', () => {
  const r = requests();
  assert.equal(r.removeItem.label, 'DELETE /api/items/{id}');
  assert.equal(r.removeItem.d.client, 'axios');
  assert.equal(r.removeItem.routes[0].target.label, 'DELETE /api/items/:id');
  assert.equal(r.stats.label, 'GET /api/stats');
  assert.equal(r.legacy.label, 'POST /api/legacy');
  assert.equal(r.legacy.routes[0].target.label, 'ALL /api/legacy');
});

test('Prisma model calls are matched against schema.prisma and marked inferred without a generated client', () => {
  const sf = a.project('next').sourceFile('next/app/api/items/[id]/route.ts');
  const del = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'DELETE');
  const q = a.outgoing(del).filter((r) => r.kind === 'queries');
  assert.deepEqual(q.map((r) => r.target.label), ['Item.delete', 'AuditLog.create']);
  assert.ok(q.every((r) => r.evidence === 'inferred'));
  assert.match(q[0].note, /schema\.prisma/);
});

test('responses: Response.json through a helper, Hono c.json, Fastify returns, Koa ctx.body, pages/api res.json', () => {
  const answers = (fw, route) => {
    const r = a.allRoutes().find((x) => x.framework === fw && `${x.method} ${x.path}` === route);
    return a.responseDetails(`route:${r.file}:${r.line}:${r.col}`).outcomes.map((o) => `${o.status}${o.sends ? ` ${o.sends.join(',')}` : ''}${o.from ? ` <${o.from}>` : ''}`);
  };
  assert.deepEqual(answers('next', 'GET /api/stats'), ['401 error <unauthorized>', '200 count <GET>']);
  assert.deepEqual(answers('next', 'DELETE /api/items/:id'), ['204 <DELETE>']);
  assert.deepEqual(answers('next', 'ALL /api/legacy'), ['200 legacy <handler>']);
  assert.equal(answers('hono', 'GET /books/:id')[0].startsWith('200 id'), true);
  assert.equal(answers('hono', 'DELETE /books/:id')[0].startsWith('204'), true);
  assert.equal(answers('fastify', 'GET /health')[0].startsWith('200 ok'), true);
  assert.equal(answers('koa-router', 'GET /shop/orders/:orderId')[0].startsWith('200 id'), true);
});
