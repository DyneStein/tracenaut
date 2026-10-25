import { existsSync } from 'node:fs';
import path from 'node:path';
import { instrument, isInstrumentable } from '@tracenaut/instrument';
import { findRepoRoot, readSession, sessionFile } from './session.js';

/**
 * Next.js loader (Turbopack and webpack, development only). For files of the project:
 *  - adds source locations to JSX and inactive function probes (the same transform as the
 *    Vite plugin), so elements can be inspected and calls recorded, on the client and in
 *    server code (Server Components, route handlers, server actions);
 *  - in client modules, adds a guarded snippet that loads the TraceNaut client in the browser.
 * Anything it cannot parse is passed through unchanged.
 */

interface LoaderContext {
  resourcePath: string;
  rootContext?: string;
  getOptions?: () => { repoRoot?: string; probes?: boolean };
  async(): (err: Error | null, code?: string, map?: unknown) => void;
  addDependency?(file: string): void;
  cacheable?(flag?: boolean): void;
}

const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;
let warned = '';

export default function tracenautLoader(this: LoaderContext, source: string, map?: unknown) {
  const done = this.async();
  const file = this.resourcePath;
  const opts = this.getOptions?.() ?? {};
  const repoRoot = path.resolve(opts.repoRoot ?? findRepoRoot(this.rootContext ?? process.cwd(), existsSync));
  if (!isInstrumentable(file) || !file.startsWith(repoRoot + path.sep) || file.includes(`${path.sep}.next${path.sep}`)) return done(null, source, map);

  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  const isClient = CLIENT_DIRECTIVE.test(source) || /(^|\/)pages\//.test(rel);
  instrument(source, file, { file: rel, jsxLocations: true, probes: opts.probes !== false }, { sourceMaps: true, inputSourceMap: (map as never) || undefined })
    .then((out) => {
      let code = out?.code ?? source;
      if (isClient) code = withClient(code, repoRoot, this);
      done(null, code, out?.map ?? map);
    })
    .catch((err: Error) => {
      const first = String(err?.message ?? err).split('\n')[0];
      if (first !== warned) console.warn(`[tracenaut] left ${rel} uninstrumented: ${first}`);
      warned = first;
      done(null, source, map);
    });
}

/** Appends a snippet that loads the TraceNaut client once, in the browser only. */
function withClient(code: string, repoRoot: string, ctx: LoaderContext) {
  // Rebuild when the daemon restarts (new port/token), so the page never keeps a stale key.
  // webpack only: Turbopack refuses dependencies outside the project.
  if ((ctx as { _compiler?: unknown })._compiler) ctx.addDependency?.(sessionFile());
  const session = readSession();
  if (!session || path.resolve(session.repoRoot) !== repoRoot) return code;
  const daemon = `http://127.0.0.1:${session.port}`;
  const config = JSON.stringify({ daemon, token: session.token, repoRoot, assets: session.assetsVersion });
  return `${code}
;if (typeof window !== 'undefined' && !window.__TRACENAUT_CONFIG__) {
  window.__TRACENAUT_CONFIG__ = ${config};
  var __tnScript = document.createElement('script');
  __tnScript.src = ${JSON.stringify(`${daemon}/client.js`)};
  __tnScript.setAttribute('data-tracenaut', '');
  (document.head || document.documentElement).appendChild(__tnScript);
}
`;
}
