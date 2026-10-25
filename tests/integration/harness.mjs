// Starts daemon + processes for a validation project, then traces HTTP requests through the
// daemon's real trace API, exactly as the browser client does (trace header + finish payload).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export async function startStack({ project, daemonPort, procs }) {
  const home = mkdtempSync(path.join(tmpdir(), 'tn-rt-'));
  const env = { ...process.env, TRACENAUT_HOME: home };
  const children = [];
  const out = {};
  const start = (name, cmd, args, cwd, extra = {}) => {
    const p = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    out[name] = '';
    p.stdout.on('data', (d) => (out[name] += d));
    p.stderr.on('data', (d) => (out[name] += d));
    children.push(p);
  };
  start('daemon', process.execPath, [`${ROOT}/packages/daemon/dist/cli.js`, 'start', project, '--port', String(daemonPort)], project);
  await until(() => { try { return JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8')); } catch { return undefined; } });
  for (const p of procs) {
    start(p.name, p.cmd ?? process.execPath, p.args, p.cwd, p.env);
    if (p.ready) await until(() => out[p.name].includes(p.ready), 30000).catch(() => { throw new Error(`${p.name} did not start:\n${out[p.name]}`); });
  }
  const session = JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8'));
  const api = (p, body) =>
    fetch(`http://127.0.0.1:${session.port}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-tracenaut-token': session.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
  return { out, session, api, stop: () => children.forEach((c) => c.kill()) };
}

export async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Trace one or more requests (sent concurrently) as one recording; returns the daemon's TraceResult. */
export async function trace(stack, base, requests) {
  const { traceId } = await stack.api('/api/trace/start', {});
  const t0 = performance.now();
  const records = await Promise.all(
    requests.map(async (r, i) => {
      const at = performance.now() - t0;
      const res = await fetch(base + r.path, { method: r.method ?? 'GET', headers: { 'x-tracenaut-trace': `${traceId}:${i + 1}`, 'content-type': 'application/json' }, body: r.body });
      await res.text();
      return { seq: i + 1, method: r.method ?? 'GET', url: r.path, at, end: performance.now() - t0, status: res.status, correlated: true };
    }),
  );
  await new Promise((r) => setTimeout(r, 150));
  return stack.api(`/api/trace/${traceId}/finish`, { calls: [], requests: records, dropped: 0, durationMs: performance.now() - t0, eventMarks: true });
}
