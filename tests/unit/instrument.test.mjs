import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentSync, createProbeRuntime, newProbeContext } from '../../packages/instrument/dist/index.js';

function run(source, file = 'src/sample.js') {
  const out = instrumentSync(source, file, { file, probes: true, jsxLocations: false });
  return out.code;
}

test('records call nesting, including across awaits', async () => {
  const ctx = newProbeContext();
  globalThis.__TRACENAUT__ = createProbeRuntime(() => ctx, () => 0);
  const code = run(`
    function leaf() { return 1; }
    async function fetchish() { await Promise.resolve(); return leaf(); }
    async function outer() { const a = leaf(); const b = await fetchish(); return a + b + after(); }
    function after() { return leaf(); }
    globalThis.__result = outer();
  `);
  new Function(code)();
  assert.equal(await globalThis.__result, 3);
  const name = (c) => c.id.split('|')[4];
  const byToken = new Map(ctx.calls.map((c) => [c.t, c]));
  const shape = ctx.calls.map((c) => `${name(c)}<${c.parent ? name(byToken.get(c.parent)) : 'root'}`);
  assert.deepEqual(shape, ['outer<root', 'leaf<outer', 'fetchish<outer', 'leaf<fetchish', 'after<outer', 'leaf<after']);
  assert.deepEqual(ctx.stack, []);
  delete globalThis.__TRACENAUT__;
});

test('instrumented code behaves identically when no trace is armed', () => {
  const code = run(`
    const obj = { m(x) { return x * 2; } };
    const arrow = (a, b = 2) => a + b;
    class C { get v() { return 5; } static s() { return 'ok'; } }
    function hoisted() { return inner(); function inner() { return arguments.length; } }
    globalThis.__out = [obj.m(2), arrow(1), new C().v, C.s(), hoisted(1, 2)];
  `);
  new Function(code)();
  assert.deepEqual(globalThis.__out, [4, 3, 5, 'ok', 0]);
});

test('adds JSX location attributes last, skipping fragments', () => {
  const file = 'web/src/App.tsx';
  const out = instrumentSync(
    `export const A = (p: {x: number}) => <><Button {...p}>hi</Button><div className="a" /></>;`,
    '/abs/web/src/App.tsx',
    { file, jsxLocations: true, probes: false },
  );
  assert.match(out.code, /<Button \{\.\.\.p\} data-tn-use="web\/src\/App\.tsx:1:39">/);
  assert.match(out.code, /<div className="a" data-tn-loc="web\/src\/App\.tsx:1:65" \/>/);
  assert.doesNotMatch(out.code, /<\s+data-tn/);
});

test('names hook callbacks and route handlers usefully', () => {
  const code = run(`
    const save = useCallback(async () => {}, []);
    router.post('/login', (req, res) => {});
  `);
  assert.match(code, /\|f\|save"/);
  assert.match(code, /\|f\|post\('\/login'\) callback"/);
});

test('calls in catch/finally after a rejected await keep their parent', async () => {
  const ctx = newProbeContext();
  globalThis.__TRACENAUT__ = createProbeRuntime(() => ctx, () => 0);
  const code = run(`
    function cleanup() {}
    function report() {}
    async function fail() { throw new Error('x'); }
    async function action() { try { await fail(); } catch (e) { report(); } finally { cleanup(); } }
    globalThis.__result = action();
  `);
  new Function(code)();
  await globalThis.__result;
  const name = (c) => c.id.split('|')[4];
  const byToken = new Map(ctx.calls.map((c) => [c.t, c]));
  const shape = ctx.calls.map((c) => `${name(c)}<${c.parent ? name(byToken.get(c.parent)) : 'root'}`);
  assert.deepEqual(shape, ['action<root', 'fail<action', 'report<action', 'cleanup<action']);
  assert.deepEqual(ctx.stack, []);
  delete globalThis.__TRACENAUT__;
});

test('decorated classes (NestJS / Angular style) are parsed and keep their decorators', () => {
  const out = instrumentSync(
    `@Controller('items')\nexport class Items {\n  @Get(':id')\n  find(id: string) { return id; }\n}\n`,
    'src/items.controller.ts',
    { file: 'src/items.controller.ts', probes: true, jsxLocations: false },
  );
  assert.match(out.code, /@Controller\('items'\)/);
  assert.match(out.code, /@Get\(':id'\)/);
});

test('the Vite plugin never breaks the app: unparsable files are served unchanged', async () => {
  const { default: tracenaut } = await import('../../packages/vite-plugin/dist/index.js');
  const plugin = tracenaut({ repoRoot: process.cwd() });
  plugin.configResolved({ root: process.cwd() });
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    const result = await plugin.transform('export const = ;', `${process.cwd()}/src/broken.ts`);
    assert.equal(result, null);
    assert.match(warnings[0], /left src\/broken\.ts uninstrumented/);
    const ok = await plugin.transform('export const a = () => <b>hi</b>;', `${process.cwd()}/src/fine.tsx`);
    assert.match(ok.code, /data-tn-loc/);
  } finally {
    console.warn = warn;
  }
});

test('modules that load before the runtime still report once it arrives (Next.js load order)', () => {
  delete globalThis.__TRACENAUT__;
  delete globalThis.__TRACENAUT_SHIM__;
  const code = run('function early() { return 1; }\nglobalThis.__early = early;', 'src/early.js');
  new Function(code)();
  assert.equal(globalThis.__early(), 1); // no runtime yet: a no-op, behaviour unchanged
  const ctx = newProbeContext();
  globalThis.__TRACENAUT__ = createProbeRuntime(() => ctx, () => 0);
  globalThis.__early();
  assert.deepEqual(ctx.calls.map((c) => c.id), ['src/early.js|1|0|f|early']);
});
