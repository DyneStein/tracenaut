import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { instrument, isInstrumentable } from '@tracenaut/instrument';

export interface TraceNautViteOptions {
  /** Repository root the daemon analyses. Default: nearest folder with tracenaut.json, else .git. */
  repoRoot?: string;
  /** Wrap functions with trace probes (inactive until a trace is armed). Default: true. */
  probes?: boolean;
}

function findRepoRoot(start: string) {
  for (const marker of ['tracenaut.json', '.git']) {
    let dir = start;
    while (true) {
      if (existsSync(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return start;
}

function readSession(): { port: number; token: string; repoRoot: string; assetsVersion?: string } | undefined {
  const file = path.join(process.env.TRACENAUT_HOME ?? path.join(homedir(), '.tracenaut'), 'daemon.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Development-only. Adds source locations to JSX and (inactive) trace probes to
 * functions, and injects the TraceNaut client when a daemon for this repo is running.
 * Production builds are untouched (`apply: 'serve'`).
 */
export default function tracenaut(options: TraceNautViteOptions = {}): Plugin {
  let repoRoot = '';
  let lastWarning = '';
  const warn = (msg: string) => {
    if (msg !== lastWarning) console.warn(`[tracenaut] ${msg}`);
    lastWarning = msg;
  };

  return {
    name: 'tracenaut',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      repoRoot = path.resolve(options.repoRoot ?? findRepoRoot(config.root));
    },
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!isInstrumentable(file) || !file.startsWith(repoRoot + path.sep)) return null;
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      try {
        const out = await instrument(code, file, { file: rel, jsxLocations: true, probes: options.probes !== false }, { sourceMaps: true });
        if (!out?.code) return null;
        return { code: out.code, map: out.map as never };
      } catch (err) {
        // Never break the app: a file TraceNaut cannot parse (unusual syntax, a mid-edit
        // save) is served unchanged; it just cannot be inspected until it parses.
        const first = String((err as Error).message ?? err).split('\n')[0];
        console.warn(`[tracenaut] left ${rel} uninstrumented: ${first}`);
        return null;
      }
    },
    async transformIndexHtml() {
      const session = readSession();
      if (!session) {
        warn('no daemon running; start one with `tracenaut start` to enable inspection');
        return [];
      }
      if (path.resolve(session.repoRoot) !== repoRoot) {
        warn(`the running daemon analyses ${session.repoRoot}, not ${repoRoot}; not injecting the client`);
        return [];
      }
      const daemon = `http://127.0.0.1:${session.port}`;
      try {
        const res = await fetch(`${daemon}/api/health`, { signal: AbortSignal.timeout(600) });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        warn(`daemon at ${daemon} is not responding; not injecting the client`);
        return [];
      }
      lastWarning = '';
      const config = { daemon, token: session.token, repoRoot, assets: session.assetsVersion };
      return [
        { tag: 'script', children: `window.__TRACENAUT_CONFIG__=${JSON.stringify(config)};`, injectTo: 'head-prepend' },
        { tag: 'script', attrs: { src: `${daemon}/client.js`, 'data-tracenaut': '' }, injectTo: 'head-prepend' },
      ];
    },
  };
}
