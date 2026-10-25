import { spawn } from 'node:child_process';
import { startStack, until } from './harness.mjs';
const HERE = new URL('.', import.meta.url).pathname;
const F = HERE + 'frameworks-app';
const AGENT = new URL('../../packages/node-agent/dist/register.js', import.meta.url).pathname;
const N = 500;
async function measure(label, headers = {}) {
  for (let i = 0; i < 50; i++) await fetch('http://127.0.0.1:4611/api/users/1', { headers }).then((r) => r.text()); // warm-up
  const t = [];
  for (let i = 0; i < N; i++) { const s = performance.now(); await fetch('http://127.0.0.1:4611/api/users/1', { headers }).then((r) => r.text()); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  const r = { label, median: +t[N >> 1].toFixed(2), p95: +t[Math.floor(N * 0.95)].toFixed(2) };
  console.log(JSON.stringify(r));
  return r;
}
// 1) no agent
const db = spawn(process.execPath, [HERE + 'db.mjs'], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => db.stdout.on('data', (d) => String(d).includes('db ready') && r()));
let app = spawn(process.execPath, ['server.js'], { cwd: F + '/fastify', stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => app.stdout.on('data', (d) => String(d).includes('ready') && r()));
await measure('no agent');
app.kill();
db.kill();
// 2) agent idle, 3) recording armed (requests carry the trace header)
const stack = await startStack({ project: F, daemonPort: 4615, procs: [{ name: 'db', args: [HERE + 'db.mjs'], cwd: HERE, ready: 'db ready' }, { name: 'fastify', args: ['--import', AGENT, 'server.js'], cwd: F + '/fastify', env: { TRACENAUT_SERVICE: 'fastify' }, ready: 'connected to TraceNaut' }] });
try {
  await measure('agent, idle');
  const { traceId } = await stack.api('/api/trace/start', {});
  await measure('agent, recording (every request traced)', { 'x-tracenaut-trace': traceId + ':1' });
  await stack.api('/api/trace/' + traceId + '/finish', { calls: [], requests: [], dropped: 0, durationMs: 1 });
} finally { stack.stop(); }
