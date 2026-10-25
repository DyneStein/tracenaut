import { startStack, trace } from './harness.mjs';
const HERE = new URL('.', import.meta.url).pathname;
const F = HERE + 'frameworks-app';
const AGENT = new URL('../../packages/node-agent/dist/register.js', import.meta.url).pathname;
const svc = (name, port) => ({ name, args: ['--import', AGENT, 'server.js'], cwd: F + '/' + name, env: { TRACENAUT_SERVICE: name }, ready: 'connected to TraceNaut' });
const stack = await startStack({ project: F, daemonPort: 4610, procs: [{ name: 'db', args: [HERE + 'db.mjs'], cwd: HERE, ready: 'db ready' }, svc('fastify'), svc('hono'), svc('koa')] });
const show = (label, result) => {
  for (const r of result.orphanRequests) {
    const sql = []; const walk = (c) => { sql.push(...c.sql.map((q) => q.sql + (q.deferred ? ' [likely]' : ''))); c.children.forEach(walk); };
    r.server?.calls.forEach(walk); sql.push(...(r.server?.sql ?? []).map((q) => q.sql + (q.deferred ? ' [likely]' : '')));
    console.log(label.padEnd(26), r.method, r.url, '→', r.status, '| route:', r.server?.routeNode?.label ?? '-', '[' + (r.server?.routeEvidence ?? '-') + ']', '| calls:', (r.server?.calls ?? []).map((c) => c.node.label).join(','), '| sql:', sql.join('; '));
  }
  const entry = result.flow?.steps.find((s) => s.type === 'server-entry');
  if (entry) console.log('   step:', entry.title, '·', entry.subtitle, '·', entry.evidence, '·', entry.tech.map((t) => t.name).join('/'));
};
try {
  show('fastify plugin route', await trace(stack, 'http://127.0.0.1:4611', [{ path: '/api/users/1' }]));
  show('fastify preHandler 401', await trace(stack, 'http://127.0.0.1:4611', [{ path: '/api/users/1' }].map((r) => r)));
  show('fastify list', await trace(stack, 'http://127.0.0.1:4611', [{ path: '/api/users' }]));
  show('hono sub-app', await trace(stack, 'http://127.0.0.1:4612', [{ path: '/api/books/2' }]));
  show('hono 404 branch', await trace(stack, 'http://127.0.0.1:4612', [{ path: '/api/books/999' }]));
  show('koa nested router', await trace(stack, 'http://127.0.0.1:4613', [{ path: '/api/orders/1' }]));
  show('koa ping', await trace(stack, 'http://127.0.0.1:4613', [{ path: '/api/ping' }]));
} finally {
  stack.stop();
  for (const n of ['fastify', 'hono', 'koa']) if (/error/i.test(stack.out[n])) console.log(n, stack.out[n].slice(-500));
}
