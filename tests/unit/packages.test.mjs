import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Analyzer, TechDetector, loadWorkspace, packageOf } from '../../packages/daemon/dist/analysis.js';

// A library TraceNaut has never heard of is still named and described, from its own
// package.json, without any registry entry. Built in a temporary folder (node_modules is
// never committed).
const root = mkdtempSync(path.join(tmpdir(), 'tn-pkg-'));
const put = (rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
put('tracenaut.json', JSON.stringify({ services: [{ name: 'api', root: 'server', kind: 'node' }] }));
put('node_modules/slugify-plus/package.json', JSON.stringify({ name: 'slugify-plus', version: '2.1.0', description: 'Turns any text into a URL-friendly slug.' }));
put('node_modules/slugify-plus/index.d.ts', 'export default function slugify(s: string): string;');
put('packages/shared/package.json', JSON.stringify({ name: '@acme/shared', version: '0.0.1' }));
put('packages/shared/index.d.ts', 'export function shared(): void;');
mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
symlinkSync(path.join(root, 'packages/shared'), path.join(root, 'node_modules/@acme/shared'));
put('server/app.ts', "import slugify from 'slugify-plus';\nimport { shared } from '@acme/shared';\nimport { x } from '@/lib/x';\nexport function title(t: string) { shared(); return slugify(t) + x; }\n");

test('packages are found the way Node finds them; aliases and missing packages give nothing', () => {
  assert.deepEqual(packageOf(root, 'server/app.ts', 'slugify-plus'), { name: 'slugify-plus', description: 'Turns any text into a URL-friendly slug.', version: '2.1.0', homepage: undefined, local: false });
  assert.equal(packageOf(root, 'server/app.ts', '@acme/shared').local, true);
  assert.equal(packageOf(root, 'server/app.ts', '@/lib/x'), undefined);
  assert.equal(packageOf(root, 'server/app.ts', 'not-installed'), undefined);
  assert.equal(packageOf(root, 'server/app.ts', 'node:fs'), undefined);
});

test('a file\'s unknown libraries become technologies described by their own package.json', () => {
  const tech = new TechDetector(new Analyzer(loadWorkspace(root)));
  const libs = tech.libraries('server/app.ts');
  const slug = libs.find((t) => t.name === 'slugify-plus');
  assert.equal(slug.what, 'Turns any text into a URL-friendly slug.');
  assert.match(slug.evidence, /package's own package\.json/);
  assert.equal(libs.find((t) => t.name === '@acme/shared').fromPackage.local, true);
  // Only listed with a step when the step's code actually calls into the package.
  assert.equal(tech.forFiles(['server/app.ts']).some((t) => t.fromPackage), false);
  assert.equal(tech.forFiles(['server/app.ts'], new Set(['slugify-plus'])).some((t) => t.name === 'slugify-plus'), true);
});
