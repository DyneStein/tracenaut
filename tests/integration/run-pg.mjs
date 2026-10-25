import { startStack, trace } from './harness.mjs';
const HERE = new URL('.', import.meta.url).pathname;
const P = HERE + 'pg-app';
const AGENT = new URL('../../packages/node-agent/dist/register.js', import.meta.url).pathname;
const stack = await startStack({
  project: P,
  daemonPort: 4600,
  procs: [
    { name: 'db', args: [HERE + 'db.mjs'], cwd: HERE, ready: 'db ready' },
    { name: 'svc2', args: ['--import', AGENT, 'svc.js'], cwd: P + '/svc2', env: { TRACENAUT_SERVICE: 'svc2' }, ready: 'connected to TraceNaut' },
    { name: 'api', args: ['--import', AGENT, 'app.js'], cwd: P + '/server', env: { TRACENAUT_SERVICE: 'api' }, ready: 'connected to TraceNaut' },
  ],
});
const show = (label, result) => {
  console.log('\n=== ' + label);
  const walk = (r, ind) => {
    console.log(ind + (r.fromServer ? '↳ ' : '') + r.method + ' ' + r.url + ' → ' + r.status + (r.server ? '' : '  [' + r.serverNote + ']'));
    if (!r.server) return;
    const sqls = [];
    const calls = (c) => { for (const q of c.sql) sqls.push([c.node.label, q]); for (const n of c.requests) walk(n, ind + '    '); c.children.forEach(calls); };
    r.server.calls.forEach(calls);
    for (const q of r.server.sql) sqls.push(['(top)', q]);
    console.log(ind + '  route: ' + (r.server.routeNode?.label ?? '-') + ' [' + (r.server.routeEvidence ?? '-') + '] calls: ' + r.server.calls.map((c) => c.node.label).join(','));
    for (const [owner, q] of sqls) console.log(ind + '  sql(' + (q.protocol ?? 'api') + (q.deferred ? ',deferred' : '') + ') ' + owner + ': ' + q.sql.slice(0, 80) + (q.rows !== undefined ? '  rows=' + q.rows : '') + (q.error ? '  ERR ' + q.error : ''));
    for (const n of r.server.requests ?? []) walk(n, ind + '    ');
  };
  for (const r of result.orphanRequests) walk(r, '');
  for (const u of result.unattributed ?? []) console.log('  unattributed(' + u.service + '): ' + u.sql.sql.slice(0, 70));
  if (result.flow) console.log('  flow: ' + result.flow.steps.map((s) => s.title + (s.evidence !== 'runtime' ? ' (' + s.evidence + ')' : '')).join(' | '));
};
try {
  const base = 'http://127.0.0.1:4601';
  show('pg Pool (driver API)', await trace(stack, base, [{ path: '/pg/users/1' }]));
  show('pg Pool, warm', await trace(stack, base, [{ path: '/pg/users/2' }]));
  show('postgres.js (wire)', await trace(stack, base, [{ path: '/pjs/users' }]));
  show('Drizzle over postgres.js', await trace(stack, base, [{ path: '/drizzle/users', method: 'POST' }]));
  show('concurrent queries in one request', await trace(stack, base, [{ path: '/both' }]));
  show('SQL error', await trace(stack, base, [{ path: '/broken' }]));
  show('two overlapping requests', await trace(stack, base, [{ path: '/pjs/users' }, { path: '/both' }]));
  show('server calls another local service', await trace(stack, base, [{ path: '/other' }]));
} finally {
  stack.stop();
  console.log('\n--- api log\n' + stack.out.api.slice(-600));
}
