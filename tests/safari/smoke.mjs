// Real-Safari smoke test, driven through Apple's safaridriver (W3C WebDriver). Playwright
// cannot drive the Safari app itself, so this runs separately from the e2e suite.
//
// Needs Safari → Developer → "Allow remote automation", and the demo running
// (npm run daemon, npm run demo:api, npm run demo:web). Then:
//   node tests/safari/smoke.mjs [http://localhost:5173] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173';
const shotsAt = process.argv.indexOf('--shots');
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
const PORT = 4471;
const driver = spawn('safaridriver', ['-p', String(PORT)], { stdio: 'ignore' });
const W3C_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
let session = '';

async function wd(method, url, body) {
  const res = await fetch(`http://localhost:${PORT}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${json.value?.message ?? res.status}`);
  return json.value;
}
const s = (p) => `/session/${session}${p}`;
const run = (script, ...args) => wd('POST', s('/execute/sync'), { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
// Everything TraceNaut renders lives in its shadow root.
const inPanel = (expr) => run(`const r = document.querySelector('tracenaut-root')?.shadowRoot; return r ? (${expr}) : null;`);

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, error: err.message });
    console.log(`✘ ${name} — ${err.message}`);
  }
}
async function shot(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, `${name}.png`), Buffer.from(await wd('GET', s('/screenshot')), 'base64'));
}

async function altRightClick(elementId) {
  await wd('POST', s('/actions'), {
    actions: [
      { type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: '' }, { type: 'pause', duration: 0 }, { type: 'pause', duration: 0 }, { type: 'keyUp', value: '' }] },
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: { [W3C_ELEMENT]: elementId }, x: 0, y: 0 },
          { type: 'pointerDown', button: 2 },
          { type: 'pointerUp', button: 2 },
          { type: 'pause', duration: 0 },
        ],
      },
    ],
  });
  await wd('DELETE', s('/actions'));
}
const find = async (css) => (await wd('POST', s('/element'), { using: 'css selector', value: css }))[W3C_ELEMENT];
const byText = (text) =>
  run(`return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === arguments[0]) ?? null;`, text).then((e) => e?.[W3C_ELEMENT]);

try {
  await until('safaridriver', () => fetch(`http://localhost:${PORT}/status`).then((r) => r.ok));
  session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId;
  await wd('POST', s('/window/rect'), { width: 1400, height: 900 });
  await wd('POST', s('/url'), { url: base });
  const ua = await run('return navigator.userAgent');
  console.log(`Safari: ${ua}`);
  await sleep(1500);
  await shot('00-loaded');
  console.log(`page: ${(await run('return document.body.innerText')).replace(/\s+/g, ' ').slice(0, 160)}`);

  await check('TraceNaut client loads in Safari', () => until('client', () => run("return !!document.querySelector('tracenaut-root')?.shadowRoot?.querySelector('.launcher')")).then(() => 'launcher rendered'));

  await check('Alt + right-click opens the TraceNaut menu, not the system menu', async () => {
    const btn = await until('Sign in button', () => byText('Sign in'));
    await altRightClick(btn);
    return until('menu', () => inPanel("r.querySelector('.menu-title')?.textContent"));
  });

  await check('Inspect produces a guided journey', async () => {
    await inPanel("r.querySelector('.menu-item').click()");
    const q = await until('question', () => inPanel("r.querySelector('.j-question')?.textContent"));
    const steps = await inPanel("r.querySelectorAll('.step').length");
    if (steps < 5) throw new Error(`only ${steps} steps`);
    await shot('01-journey');
    return `${q} (${steps} steps)`;
  });

  await check('Icons load (SVG from the daemon)', async () => {
    // Every icon must actually be loaded and drawn, not merely "not broken" (a lazy image
    // that never loads is neither complete nor broken).
    const stats = await until('icons loaded', async () => {
      const st = await inPanel("(() => { const imgs = [...r.querySelectorAll('img.i3d')]; return { total: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }; })()");
      return st.total && st.loaded === st.total ? st : undefined;
    }, 5000).catch(async () => { throw new Error(JSON.stringify(await inPanel("(() => { const imgs = [...r.querySelectorAll('img.i3d')]; return { total: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }; })()"))); });
    return `${stats.loaded}/${stats.total} icons loaded`;
  });

  await check('A step expands with its explanation', async () => {
    await inPanel("r.querySelectorAll('.step-main')[3].click()");
    return until('detail', () => inPanel("r.querySelector('.step.open .detail-summary')?.textContent?.slice(0, 60)"));
  });

  await check('Concept card opens on a term', async () => {
    await inPanel("r.querySelector('.step.open .term')?.click()");
    return until('card', () => inPanel("r.querySelector('.concept')?.textContent?.slice(0, 50)"), 4000);
  });

  await check('Layers view renders lanes and branches', async () => {
    await inPanel("[...r.querySelectorAll('[role=tab]')].find((t) => t.textContent.includes('Layers')).click()");
    const info = await until('layers', () => inPanel("r.querySelector('.layers') && { labels: [...r.querySelectorAll('.layer-label b')].map((b) => b.textContent), branches: r.querySelectorAll('.branch').length }"));
    await shot('02-layers');
    return `${info.labels.join(' / ')} · ${info.branches} branches`;
  });

  await check('Watch it happen records a real sign-in (password never shown)', async () => {
    await inPanel("[...r.querySelectorAll('[role=tab]')].find((t) => t.textContent.includes('Step by step')).click()");
    const pw = await find('input[type=password]');
    await wd('POST', s(`/element/${pw}/clear`), {});
    await wd('POST', s(`/element/${pw}/value`), { text: 'analytical' });
    await inPanel("r.querySelector('.watch-btn').click()");
    await until('armed', () => inPanel("r.querySelector('.j-armed')"));
    await wd('POST', s(`/element/${await byText('Sign in')}/click`), {});
    const q = await until('recording', () => inPanel("(r.querySelector('.j-question')?.textContent ?? '').startsWith('What happened') && r.querySelector('.j-headline')?.textContent"), 25000);
    const leaked = await inPanel("r.innerHTML.includes('analytical')");
    if (leaked) throw new Error('password text found in the panel');
    await shot('03-recorded');
    return q;
  });

  await check('Panel scrolls inside itself without moving the page', async () => {
    const before = await run('return window.scrollY');
    await inPanel("(() => { const b = r.querySelector('.body'); b.scrollTop = b.scrollHeight; return b.scrollTop; })()");
    const after = await run('return window.scrollY');
    if (before !== after) throw new Error(`page scrolled ${before} → ${after}`);
    return 'page did not move';
  });
} catch (err) {
  console.log(`✘ setup — ${err.message}`);
  results.push({ name: 'setup', ok: false, error: err.message });
} finally {
  if (session) await wd('DELETE', s('')).catch(() => {});
  driver.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
