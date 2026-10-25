import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Analyzer, loadWorkspace, JourneyBuilder } from '../../packages/daemon/dist/analysis.js';
import { signInRequest } from './helpers/signin.mjs';

const analyzer = new Analyzer(loadWorkspace('examples/taskboard'));
const journeys = new JourneyBuilder(analyzer);

async function journeyFor(req) {
  const inspect = await analyzer.inspect(req);
  return journeys.staticFlows(req, inspect);
}

const step = (flow, type) => flow.steps.find((s) => s.type === type);
const techKinds = (s) => Object.fromEntries(s.tech.map((t) => [t.name, t.kind]));

test('Sign in: the journey follows the code from the click to the database and back', async () => {
  const [flow] = await journeyFor(signInRequest);
  assert.equal(flow.question, 'What happens when you click “Sign in”?');
  assert.deepEqual(
    flow.steps.map((s) => `${s.zone}:${s.type}`),
    ['browser:interaction', 'browser:ui-logic', 'browser:client-logic', 'network:request', 'server:server-entry', 'server:server-logic', 'database:database', 'network:response', 'browser:ui-update'],
  );
  assert.match(flow.summary, /POST \/api\/auth\/login request with email and password/);
});

test('Sign in: what is sent and what can come back is read from the code', async () => {
  const [flow] = await journeyFor(signInRequest);
  const req = step(flow, 'request');
  assert.equal(req.facts.find((f) => f.label === 'Sends').value, 'email and password');
  assert.equal(req.facts.find((f) => f.label === 'Method').value, 'POST');
  const resp = step(flow, 'response');
  assert.deepEqual(resp.facts.map((f) => `${f.label}: ${f.value}`), ['200 OK: sends user', '401 Unauthorized: sends error']);
  assert.match(resp.summary, /cookie\|session-cookie\]\] named tb_session/);
  const db = step(flow, 'database');
  assert.deepEqual(db.facts.map((f) => f.value), [
    'SELECT id, email, name, password_hash FROM users WHERE email = ?',
    'INSERT INTO sessions (token, user_id) VALUES (?, ?)',
  ]);
});

test('Sign in: technologies are identified with their kind and evidence', async () => {
  const [flow] = await journeyFor(signInRequest);
  assert.deepEqual(techKinds(step(flow, 'interaction')), { TSX: 'language', React: 'library' });
  assert.deepEqual(techKinds(step(flow, 'request')), { HTTP: 'protocol', JSON: 'data-format', 'fetch()': 'browser-api' });
  assert.deepEqual(techKinds(step(flow, 'server-entry')), { 'Node.js': 'runtime', Express: 'framework', JavaScript: 'language' });
  assert.deepEqual(techKinds(step(flow, 'database')), { SQL: 'language', SQLite: 'database', 'node:sqlite': 'library' });
  for (const s of flow.steps) for (const t of s.tech) assert.ok(t.evidence.length > 8, `${t.name} needs evidence`);
  assert.match(step(flow, 'interaction').tech.find((t) => t.name === 'React').evidence, /LoginForm\.tsx imports .* from 'react'/);
});

test('Sign in: certainty is never overstated', async () => {
  const [flow] = await journeyFor(signInRequest);
  assert.ok(flow.steps.every((s) => s.evidence !== 'runtime'), 'nothing is observed before running');
  assert.equal(step(flow, 'ui-logic').evidence, 'inferred');
  assert.match(step(flow, 'ui-logic').evidenceNote, /React context/);
  assert.equal(step(flow, 'server-entry').evidence, 'inferred');
  // The only runtime fact is that the handler is attached in the live page.
  const live = step(flow, 'interaction').facts.find((f) => f.label === 'Live check');
  assert.equal(live.evidence, 'runtime');
});

test('every explainable term in a journey has an explanation in the concept library', async () => {
  const source = readFileSync('packages/client/src/learn/concepts.ts', 'utf8');
  const known = new Set([...source.matchAll(/^ {2}'?([a-z][\w-]*)'?: \{/gm)].map((m) => m[1]));
  const flows = [...(await journeyFor(signInRequest)), ...(await journeyFor(deleteRequest))];
  const text = flows.flatMap((f) => [f.summary, ...f.steps.flatMap((s) => [s.summary, ...s.facts.map((x) => x.value)])]).join(' ');
  const used = [...text.matchAll(/\[\[[^|\]]+\|([^\]]+)\]\]/g)].map((m) => m[1]);
  assert.ok(used.length > 15);
  for (const id of new Set(used)) assert.ok(known.has(id), `missing concept: ${id}`);
  for (const f of flows) for (const s of f.steps) for (const t of s.tech) assert.ok(known.has(t.id), `missing concept for tech: ${t.id}`);
});

const deleteRequest = {
  adapter: 'react',
  element: { tag: 'button', text: 'Delete', attributes: { 'aria-label': 'Delete Read the README' } },
  chain: [
    { type: 'host', name: 'button', loc: 'web/src/components/Button.tsx:10:4', runtimeHandlers: ['onClick'] },
    { type: 'component', name: 'Button', loc: 'web/src/components/TaskItem.tsx:17:6' },
    { type: 'host', name: 'li', loc: 'web/src/components/TaskItem.tsx:12:4', runtimeHandlers: [] },
    { type: 'component', name: 'TaskItem', loc: 'web/src/components/TaskBoard.tsx:21:12' },
  ],
};

test('Delete: props, middleware and alternative answers are all represented', async () => {
  const [flow] = await journeyFor(deleteRequest);
  assert.match(step(flow, 'interaction').summary, /handed down through \[\[props\|props\]\]/);
  assert.equal(step(flow, 'request').subtitle, 'DELETE /api/tasks/{id}');
  assert.match(step(flow, 'request').summary, /The id part of the address is filled in when the code runs/);
  assert.match(step(flow, 'server-entry').summary, /requireAuth \(this app's own code\)/);
  const answers = step(flow, 'response').facts.map((f) => f.label);
  assert.deepEqual(answers.sort(), ['204 No Content', '401 Unauthorized', '404 Not Found']);
  assert.ok(step(flow, 'response').facts.find((f) => f.label === '401 Unauthorized').value.includes('from requireAuth'));
});

test('elements without source or without handlers say so instead of guessing', async () => {
  const [none] = await journeyFor({ adapter: 'dom', element: { tag: 'div', text: 'Injected', attributes: {} }, chain: [] });
  assert.equal(none.steps.length, 0);
  assert.match(none.summary, /can't tell/);
  const [plain] = await journeyFor({
    adapter: 'react',
    element: { tag: 'h1', text: 'Sign in', attributes: {} },
    chain: [{ type: 'host', name: 'h1', loc: 'web/src/components/LoginForm.tsx:27:6', runtimeHandlers: [] }],
  });
  assert.equal(plain.steps.length, 1);
  assert.match(plain.summary, /Nothing in the app's code reacts/);
});

test('observed journeys come from the recording, and missing server detail is stated', () => {
  const node = (label, file, line) => ({ id: `fn:${file}:${line}:0`, kind: 'function', label, source: { service: file.startsWith('server') ? 'api' : 'web', file, line }, expandable: true });
  const flow = journeys.observedFlow({
    id: 't',
    action: { type: 'click', at: 0, tag: 'button', text: 'Go', loc: 'web/src/App.tsx:1:0' },
    durationMs: 20,
    calls: [
      {
        node: node('request', 'web/src/api/client.ts', 15),
        probe: 'p1',
        at: 1,
        children: [],
        sql: [],
        requests: [{ at: 2, method: 'GET', url: '/api/tasks', status: 200, durationMs: 4, serverNote: 'no backend agent connected' }],
      },
    ],
    renders: [],
    orphanRequests: [],
    agents: [{ service: 'api', connected: false }],
    notes: [],
  });
  assert.deepEqual(flow.steps.map((s) => s.type), ['interaction', 'client-logic', 'request', 'unknown', 'response']);
  assert.ok(flow.steps.filter((s) => s.type !== 'unknown').every((s) => s.evidence === 'runtime'));
  assert.match(step(flow, 'unknown').summary, /server side was not observed: no backend agent connected/);
  assert.equal(step(flow, 'response').subtitle, '200 OK');
});

test('code views mark notation a beginner may not know', async () => {
  const d = await analyzer.node('fn:web/src/components/LoginForm.tsx:12:2');
  const concepts = new Set(d.code.syntax.map((s) => s.concept));
  for (const c of ['async-await', 'try-catch', 'type-annotation', 'ternary']) assert.ok(concepts.has(c), c);
  const sql = await analyzer.node('sql:server/db/sessionsRepo.js:4:13');
  assert.equal(sql.code.syntax.filter((s) => s.concept === 'sql-placeholder').length, 2);
});

// A recording where only the first top-level call ran inside the click's dispatch; two
// later ones (say, an animation frame and a timer) did not. Nodes are synthetic.
const call = (label, file, byEvent) => ({
  node: { id: `fn:${file}:1:0`, kind: 'function', label, source: { service: 'web', file, line: 1, col: 0 }, expandable: true },
  probe: `${file}|1|0|f|${label}`,
  at: 0,
  byEvent,
  children: [],
  requests: [],
  sql: [],
});

test('recordings: only calls the event ran are presented as caused; the rest "also ran" and are grouped', () => {
  const flow = journeys.observedFlow({
    id: 't',
    action: { type: 'click', at: 0, tag: 'button', text: 'Go' },
    durationMs: 10,
    eventMarks: true,
    calls: [call('onGo', 'web/src/components/TaskBoard.tsx', true), call('tick', 'web/src/api/tasks.ts', false), call('poll', 'web/src/api/client.ts', false)],
    renders: [],
    orphanRequests: [],
    agents: [],
    notes: [],
  });
  const titles = flow.steps.map((s) => s.title);
  assert.equal(titles[1].startsWith('Also ran'), false, titles.join(' | '));
  const also = flow.steps.filter((s) => s.title === 'Also ran during the recording');
  assert.equal(also.length, 1, 'later unrelated calls are merged into one step');
  assert.deepEqual(also[0].functions.map((f) => f.node.label), ['tick', 'poll']);
  assert.equal(also[0].incidental, true);
  assert.match(also[0].summary, /cannot tell whether your action caused/);
});

test('recordings: a first call that did not run inside the event is not presented as caused by it', () => {
  const flow = journeys.observedFlow({
    id: 't',
    action: { type: 'click', at: 0, tag: 'a', text: 'Sessions' },
    durationMs: 10,
    eventMarks: true,
    calls: [call('aimAt', 'web/src/components/TaskBoard.tsx', false)],
    renders: [],
    orphanRequests: [],
    agents: [],
    notes: [],
  });
  assert.equal(flow.steps[1].title, 'Also ran during the recording');
});

test('an element drawn by library code is not reported as doing nothing', async () => {
  // e.g. an <a> rendered by a router component inside the app's <div class="brand">:
  // the app has no handler, but the element has one at runtime and is a link.
  const req = {
    adapter: 'react',
    element: { tag: 'a', text: 'Home', attributes: { href: '/home' } },
    chain: [{ type: 'host', name: 'div', loc: 'web/src/components/Header.tsx:9:6', runtimeHandlers: [] }],
    leaf: { tag: 'a', runtimeHandlers: ['onClick'] },
  };
  const [flow] = await journeyFor(req);
  assert.doesNotMatch(flow.headline, /Nothing/);
  assert.equal(flow.headline, 'It is a link to /home.');
  assert.match(flow.steps[0].summary, /library code attached it/);
  assert.match(flow.steps[0].summary, /a click handler may change what happens/);
});

test('clicking the icon inside a submit button submits the form (not "nothing happens")', async () => {
  const req = {
    ...signInRequest,
    element: { tag: 'svg', text: '', attributes: {} },
    leaf: { tag: 'svg', runtimeHandlers: [] },
  };
  const [flow] = await journeyFor(req);
  assert.doesNotMatch(flow.headline, /Nothing/);
  assert.equal(flow.steps[0].subtitle, 'submits the form');
  assert.match(flow.steps[0].summary, /icon is inside a submit button/);
  assert.ok(flow.steps.some((s) => s.type === 'request' && s.subtitle === 'POST /api/auth/login'));
});
