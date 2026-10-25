import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, loadWorkspace, buildTrace, matchRoute } from '../../packages/daemon/dist/analysis.js';

const edge = new Analyzer(loadWorkspace('tests/fixtures/edge'));
const demo = new Analyzer(loadWorkspace('examples/taskboard'));

const fnId = (a, file, name) => {
  const sf = a.projectFor(file).sourceFile(file);
  const idx = sf.text.indexOf(`function ${name}`);
  const { line, character } = sf.getLineAndCharacterOfPosition(idx);
  const lineText = sf.text.split('\n')[line];
  const col = lineText.indexOf('async ') >= 0 && lineText.indexOf('async ') < character ? lineText.indexOf('async ') : character;
  return `fn:${file}:${line + 1}:${col}`;
};

test('dynamic URL parts stay symbolic and are marked unresolved', async () => {
  const d = await edge.node(fnId(edge, 'web/api.ts', 'dynamicUrl'));
  const req = d.relations.find((r) => r.kind === 'requests');
  assert.equal(req.target.label, 'GET {base}/items/{id}');
  assert.equal(req.evidence, 'unresolved');
});

test('literal requests are static, computed methods are not guessed', async () => {
  const lit = await edge.node(fnId(edge, 'web/api.ts', 'literal'));
  assert.equal(lit.relations.find((r) => r.kind === 'requests').target.label, 'POST /api/items');
  assert.equal(lit.relations.find((r) => r.kind === 'requests').evidence, 'static');
  const comp = await edge.node(fnId(edge, 'web/api.ts', 'computedMethod'));
  const req = comp.relations.find((r) => r.kind === 'requests');
  assert.equal(req.target.label.startsWith('? '), true, req.target.label);
  assert.equal(req.evidence, 'unresolved');
});

test('look-alikes are not reported as HTTP requests', async () => {
  for (const name of ['notHttp', 'cacheLookup']) {
    const d = await edge.node(fnId(edge, 'web/api.ts', name));
    assert.equal(d.relations.some((r) => r.kind === 'requests'), false, name);
  }
});

test('routes come only from express()/Router() receivers, with mount prefixes', () => {
  const routes = edge.allRoutes().map((r) => `${r.method} ${r.path}${r.mounted ? '' : ' (unmounted)'}`).sort();
  assert.deepEqual(routes, ['GET /api/items', 'GET /api/items/:id', 'GET /lonely (unmounted)', 'POST /api/items']);
});

test('route matching distinguishes parameters from literals', () => {
  const [byId] = edge.allRoutes().filter((r) => r.path === '/api/items/:id');
  assert.ok(matchRoute('GET', '/api/items/{id}', byId));
  assert.ok(matchRoute('GET', '/api/items/42', byId));
  assert.equal(matchRoute('POST', '/api/items/42', byId), undefined);
  assert.equal(matchRoute('GET', '/api/items/42/extra', byId), undefined);
});

test('demo: middleware order includes app- and router-level middleware', () => {
  const route = demo.allRoutes().find((r) => r.method === 'DELETE');
  assert.equal(route.path, '/api/tasks/:id');
  assert.deepEqual(route.middleware.map((m) => `${m.scope}:${m.expr.getText()}`), ['app:express.json()', 'router:requireAuth']);
});

test('trace assembly says so when no backend agent was connected', () => {
  const result = buildTrace(
    demo,
    't1',
    {
      action: { type: 'click', at: 0, tag: 'button', text: 'Go', loc: 'web/src/App.tsx:1:0' },
      calls: [{ t: 1, id: 'web/src/api/client.ts|15|7|f|request', parent: 0, at: 0, end: 5 }],
      requests: [{ seq: 1, method: 'GET', url: '/api/tasks', initiator: 1, at: 1, end: 4, status: 200, correlated: true }],
      dropped: 0,
      durationMs: 10,
    },
    [],
    [{ service: 'api', connected: false }],
  );
  assert.equal(result.calls[0].node.label, 'request');
  assert.equal(result.calls[0].requests[0].serverNote, 'no backend agent connected');
  assert.ok(result.notes.some((n) => n.includes('No runtime agent is connected for "api"')));
});

test('a request whose only unknowns are whole path segments is static and matched', async () => {
  const d = await demo.node(fnId(demo, 'web/src/api/tasks.ts', 'setTaskDone'));
  const req = d.relations.find((r) => r.kind === 'requests');
  assert.equal(req.target.label, 'PATCH /api/tasks/{id}');
  assert.equal(req.evidence, 'static');
  const http = await demo.node(req.target.id);
  assert.deepEqual(http.relations.map((r) => `${r.evidence} ${r.target.label}`), ['inferred PATCH /api/tasks/:id']);
});
