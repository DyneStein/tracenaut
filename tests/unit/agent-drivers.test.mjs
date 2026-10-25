import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The Node agent observes better-sqlite3 and pg. Neither package is installed here, so this
// test uses stand-ins with the same API shape (Database#prepare → Statement with `.source`;
// Client#query with promise and callback forms). It checks the agent's patching and request
// correlation, not the real drivers; ccam (better-sqlite3) is exercised at runtime separately.

const root = path.resolve('.');
const agent = path.join(root, 'packages/node-agent/dist/register.js');
const cli = path.join(root, 'packages/daemon/dist/cli.js');

function files(dir) {
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put('tracenaut.json', JSON.stringify({ services: [{ name: 'api', root: 'server', kind: 'node' }] }));
  put('server/package.json', JSON.stringify({ name: 'api', type: 'module' }));
  put(
    'server/node_modules/better-sqlite3/index.js',
    `class Statement { constructor(source) { this.source = source; } get() { return { id: 1 }; } all() { return [1, 2, 3]; } run() { return { changes: 1 }; } }
     class Database { prepare(sql) { return new Statement(sql); } exec() {} }
     module.exports = Database;`,
  );
  put(
    'server/node_modules/pg/index.js',
    `class Client { query(q, values, cb) { if (typeof values === 'function') { cb = values; } const res = { rowCount: 2 };
       if (typeof cb === 'function') { setTimeout(() => cb(null, res), 1); return undefined; } return new Promise((r) => setTimeout(() => r(res), 1)); } }
     module.exports = { Client };`,
  );
  put(
    'server/index.js',
    `import http from 'node:http';
     import Database from 'better-sqlite3';
     import pg from 'pg';
     const db = new Database();
     const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
     const client = new pg.Client();
     function handle(req, res) {
       getUser.get(req.url.length);
       db.prepare('UPDATE users SET seen = 1').run();
       client.query({ text: 'SELECT count(*) FROM events WHERE secret = $1' }, ['not-recorded']).then(() => {
         client.query('DELETE FROM sessions', () => res.end('ok'));
       });
     }
     http.createServer(handle).listen(Number(process.env.PORT), () => console.log('ready'));`,
  );
}

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
};

test('agent records better-sqlite3 and pg statements for traced requests only, without values', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tn-drivers-'));
  const home = path.join(dir, '.home');
  files(dir);
  const env = { ...process.env, TRACENAUT_HOME: home };
  const procs = [];
  t.after(() => {
    for (const p of procs) p.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  procs.push(spawn(process.execPath, [cli, 'start', dir, '--port', '4561'], { env, stdio: 'ignore' }));
  const session = await waitFor(() => JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8')));
  let out = '';
  const server = spawn(process.execPath, ['--import', agent, 'index.js'], { cwd: path.join(dir, 'server'), env: { ...env, PORT: '4562', TRACENAUT_SERVICE: 'api' } });
  procs.push(server);
  server.stdout.on('data', (d) => (out += d));
  await waitFor(() => out.includes('connected to TraceNaut'));

  const api = (p, body) =>
    fetch(`http://127.0.0.1:${session.port}${p}`, { method: 'POST', headers: { 'x-tracenaut-token': session.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

  // An untraced request first: nothing may be recorded for it.
  await fetch('http://127.0.0.1:4562/untraced').then((r) => r.text());
  const { traceId } = await api('/api/trace/start');
  await fetch('http://127.0.0.1:4562/traced', { headers: { 'x-tracenaut-trace': `${traceId}:1` } }).then((r) => r.text());
  const result = await api(`/api/trace/${traceId}/finish`, {
    calls: [],
    requests: [{ seq: 1, method: 'GET', url: 'http://127.0.0.1:4562/traced', at: 0, status: 200, durationMs: 5 }],
    dropped: 0,
    durationMs: 10,
  });
  const text = JSON.stringify(result);
  for (const sql of ['SELECT * FROM users WHERE id = ?', 'UPDATE users SET seen = 1', 'SELECT count(*) FROM events WHERE secret = $1', 'DELETE FROM sessions']) {
    assert.ok(text.includes(sql), `missing ${sql}`);
  }
  assert.equal(text.includes('not-recorded'), false, 'parameter values must never be recorded');
  assert.match(out, /observing better-sqlite3/);
  assert.match(out, /observing pg/);
});
