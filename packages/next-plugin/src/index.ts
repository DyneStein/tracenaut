import path from 'node:path';

/**
 * Development-only Next.js integration:
 *
 *   // next.config.ts
 *   import withTraceNaut from '@tracenaut/next';
 *   export default withTraceNaut({ ...your config });
 *
 * Registers TraceNaut's loader for Turbopack (`next dev --turbopack`) and webpack (`next dev`).
 * Production builds are untouched. For server-side recording, start the dev server with the
 * Node agent: NODE_OPTIONS="--import @tracenaut/node-agent" next dev
 */

export interface TraceNautNextOptions {
  /** Repository root the daemon analyses. Default: nearest folder with tracenaut.json, else .git. */
  repoRoot?: string;
  /** Add (inactive) function probes. Default: true. */
  probes?: boolean;
}

type HeaderRule = { source: string; headers: { key: string; value: string }[] } & Record<string, unknown>;
type NextConfig = Record<string, unknown> & {
  headers?: () => Promise<HeaderRule[]> | HeaderRule[];
  webpack?: (config: WebpackConfig, ctx: { dev: boolean; isServer: boolean }) => WebpackConfig;
  turbopack?: { rules?: Record<string, unknown> } & Record<string, unknown>;
};
type WebpackConfig = { module?: { rules?: unknown[] } } & Record<string, unknown>;

const LOADER = path.join(__dirname, 'loader.cjs');

const DAEMON_ORIGIN = 'http://127.0.0.1:*';
const NEEDED = ['script-src', 'script-src-elem', 'connect-src', 'img-src'];

/** Adds the local daemon's origin to the CSP directives TraceNaut needs. */
export function allowTraceNaut(csp: string): string {
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  const byName = new Map(directives.map((d) => [d.split(/\s+/)[0].toLowerCase(), d]));
  const fallback = byName.get('default-src');
  for (const name of NEEDED) {
    const d = byName.get(name);
    if (d) {
      if (!d.includes(DAEMON_ORIGIN) && !/\s\*(\s|$)/.test(d)) byName.set(name, `${d} ${DAEMON_ORIGIN}`);
    } else if (fallback && name !== 'script-src-elem') {
      // Without its own directive the browser uses default-src (and script-src-elem falls back
      // to script-src, which is handled here).
      byName.set(name, `${name} ${fallback.split(/\s+/).slice(1).join(' ')} ${DAEMON_ORIGIN}`);
    }
  }
  return `${[...byName.values()].join('; ')};`;
}

/** Major version of the Next.js the project uses (its rule syntax changed in 16). */
function nextMajor() {
  try {
    const pkg = require(require.resolve('next/package.json', { paths: [process.cwd()] })) as { version: string };
    return Number(pkg.version.split('.')[0]);
  } catch {
    return 15;
  }
}
const SOURCES = /\.(m|c)?[jt]sx?$/;

export default function withTraceNaut(nextConfig: NextConfig = {}, options: TraceNautNextOptions = {}): NextConfig {
  if (process.env.NODE_ENV === 'production') return nextConfig;
  // Turbopack requires plain, serialisable loader options (no undefined values).
  const loaderOptions: Record<string, string | boolean> = {};
  if (options.repoRoot) loaderOptions.repoRoot = options.repoRoot;
  if (options.probes !== undefined) loaderOptions.probes = options.probes;
  const loader = { loader: LOADER, options: loaderOptions };
  const rules = { ...(nextConfig.turbopack?.rules ?? {}) };
  const major = nextMajor();
  for (const glob of ['*.tsx', '*.ts', '*.jsx', '*.js', '*.mjs']) {
    if (rules[glob]) {
      console.warn(`[tracenaut] turbopack.rules['${glob}'] is already configured; TraceNaut leaves it as it is`);
      continue;
    }
    // Only the project's own files ("foreign" = node_modules): routing dependencies through a
    // loader changes how Turbopack resolves their imports. Turbopack runs these loaders
    // before its own TypeScript/JSX transform.
    const item = { loaders: [loader] };
    rules[glob] = major >= 16 ? { condition: { not: 'foreign' }, ...item } : { foreign: false, default: item };
  }
  const appHeaders = nextConfig.headers;
  return {
    ...nextConfig,
    // A Content-Security-Policy set by the app would block TraceNaut's client, its icons and
    // its calls to the local daemon. In development only, the daemon's origin is allowed.
    ...(appHeaders
      ? {
          async headers() {
            const rules = await appHeaders();
            return rules.map((rule) => ({
              ...rule,
              headers: rule.headers.map((h) => (/^content-security-policy(-report-only)?$/i.test(h.key) ? { ...h, value: allowTraceNaut(h.value) } : h)),
            }));
          },
        }
      : {}),
    turbopack: { ...(nextConfig.turbopack ?? {}), rules },
    webpack(config, ctx) {
      if (ctx.dev) {
        config.module ??= {};
        config.module.rules ??= [];
        config.module.rules.unshift({ test: SOURCES, exclude: /node_modules|[\\/]\.next[\\/]/, enforce: 'pre', use: [loader] });
      }
      return nextConfig.webpack ? nextConfig.webpack(config, ctx) : config;
    },
  };
}
