// Builds every TraceNaut package with esbuild. Type checking is separate: `npm run typecheck`.
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const nodeCommon = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  // Workspace packages are bundled in; third-party packages stay external.
  plugins: [
    {
      name: 'bundle-workspace',
      setup(b) {
        b.onResolve({ filter: /^@tracenaut\// }, (args) => {
          const pkg = args.path.slice('@tracenaut/'.length);
          const entry = pkg === 'assets' ? 'src/index.mjs' : 'src/index.ts';
          return { path: new URL(`../packages/${pkg}/${entry}`, import.meta.url).pathname };
        });
      },
    },
  ],
};

const only = (entry, opts) => (existsSync(entry) ? build({ ...opts, entryPoints: [entry] }) : null);
const jobs = [
  only('packages/daemon/src/cli.ts', { ...nodeCommon, outfile: 'packages/daemon/dist/cli.js', banner: { js: '#!/usr/bin/env node' } }),
  only('packages/daemon/src/analysis/index.ts', { ...nodeCommon, outfile: 'packages/daemon/dist/analysis.js' }),
  only('packages/vite-plugin/src/index.ts', { ...nodeCommon, outfile: 'packages/vite-plugin/dist/index.js' }),
  only('packages/node-agent/src/register.ts', { ...nodeCommon, outfile: 'packages/node-agent/dist/register.js' }),
  only('packages/instrument/src/index.ts', { ...nodeCommon, outfile: 'packages/instrument/dist/index.js' }),
  only('packages/client/src/index.tsx', {
    outfile: 'packages/client/dist/client.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'text' },
    minify: !watch,
    sourcemap: true,
    alias: { '@tracenaut/protocol': './packages/protocol/src/index.ts', '@tracenaut/instrument/runtime': './packages/instrument/src/runtime.ts' },
  }),
];

await Promise.all(jobs.filter(Boolean));
await mkdir('packages/extension/dist', { recursive: true });
if (existsSync('packages/extension/src')) await cp('packages/extension/src', 'packages/extension/dist', { recursive: true });
console.log('built all packages');
