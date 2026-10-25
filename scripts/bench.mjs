// Performance baseline for TraceNaut. Starts an isolated daemon, demo API and dev server,
// then measures what a user feels: bundle size, cold analysis, journey latency, panel
// time-to-content, long tasks, and memory/listener growth over repeated inspections.
//
//   node scripts/bench.mjs [--json out.json]
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const home = mkdtempSync(path.join(tmpdir(), 'tracenaut-bench-'));
const env = { ...process.env, TRACENAUT_HOME: home, PORT: '3102', WEB_PORT: '5274', TASKBOARD_DB: path.join(home, 'db.sqlite') };
const procs = [];
const start = (cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
const waitFor = async (url, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
};
const rss = (pid) => Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = {};

try {
  const bundle = readFileSync(path.join(root, 'packages/client/dist/client.js'));
  results.bundle = { rawKB: +(bundle.length / 1024).toFixed(1), gzipKB: +(gzipSync(bundle).length / 1024).toFixed(1) };

  const t0 = Date.now();
  const daemon = start('node', ['packages/daemon/dist/cli.js', 'start', 'examples/taskboard', '--port', '4498'], root);
  await new Promise((resolve) => daemon.stdout.on('data', (d) => String(d).includes('analysis ready') && resolve()));
  results.daemon = { coldStartToAnalysisReadyMs: Date.now() - t0 };
  start('node', ['--import', '@tracenaut/node-agent', 'server/index.js'], path.join(root, 'examples/taskboard'));
  start('npx', ['vite', '--config', 'web/vite.config.ts'], path.join(root, 'examples/taskboard'));
  await waitFor('http://localhost:3102/api/health');
  await waitFor('http://localhost:5274/');

  const session = JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8'));
  const { signInRequest } = await import(path.join(root, 'tests/unit/helpers/signin.mjs'));
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await fetch(`http://127.0.0.1:${session.port}/api/journey`, { method: 'POST', headers: { 'x-tracenaut-token': session.token, 'content-type': 'application/json' }, body: JSON.stringify(signInRequest) });
    times.push(performance.now() - t);
  }
  results.journeyApi = { firstMs: +times[0].toFixed(1), medianMs: +median(times.slice(1)).toFixed(1) };

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners };
  };
  await page.goto('http://localhost:5274/');
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await signIn.waitFor();
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask' });
  });
  const panelTimes = [];
  const inspectOnce = async () => {
    const t = performance.now();
    await signIn.click({ button: 'right', modifiers: ['Alt'] });
    await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
    await page.locator('tracenaut-root .step').first().waitFor();
    panelTimes.push(performance.now() - t);
  };
  // Every sample is taken in the same state: a fresh journey on screen, nothing expanded.
  const round = async (n) => {
    for (let i = 0; i < n; i++) {
      await inspectOnce();
      await page.locator('tracenaut-root .step-main').nth(i % 5).click();
    }
    await inspectOnce();
    return metrics();
  };
  await inspectOnce();
  const before = await metrics();
  const after = await round(30);
  // Past the 50-entry history cap, older journeys are released: growth should flatten.
  const later = await round(60);
  results.panel = {
    firstOpenMs: +panelTimes[0].toFixed(0),
    medianOpenMs: +median(panelTimes.slice(1)).toFixed(0),
    longTasksOver50ms: (await page.evaluate(() => window.__long)).length,
  };
  results.repeatedInspections30 = { before, after, heapGrowthMB: +(after.heapMB - before.heapMB).toFixed(2), listenerGrowth: after.listeners - before.listeners };
  results.repeatedInspections90 = { after: later, heapGrowthMB: +(later.heapMB - before.heapMB).toFixed(2), listenerGrowth: later.listeners - before.listeners, growthFrom30to90MB: +(later.heapMB - after.heapMB).toFixed(2) };
  results.daemon.rssMB = +rss(daemon.pid).toFixed(0);
  await browser.close();
} finally {
  for (const p of procs) p.kill();
}

console.log(JSON.stringify(results, null, 2));
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, 2));
process.exit(0);
