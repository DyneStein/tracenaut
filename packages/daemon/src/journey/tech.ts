import type { TechRef } from '@tracenaut/protocol';
import { TECHNOLOGIES } from '@tracenaut/assets';
import type { Analyzer } from '../analysis/analyzer.js';
import { readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Identifies the technologies involved in a journey step from project evidence: file
 * extensions and syntax, import statements, service configuration and API usage. Names,
 * kinds, icons and plain descriptions come from the asset registry; every TechRef says how
 * it was identified. Nothing is assumed from folder or function names.
 */

type RegistryTech = (typeof TECHNOLOGIES)[number];
const byId = new Map<string, RegistryTech>(TECHNOLOGIES.map((t) => [t.id, t]));

/** Registry technology for an imported module name (exact package, scoped prefix, or node: import). */
export function techForModule(module: string): RegistryTech | undefined {
  const pkg = module.startsWith('@') ? module.split('/').slice(0, 2).join('/') : module.split('/')[0];
  for (const t of TECHNOLOGIES) {
    const s = t.signals as { npm?: string[]; imports?: string[] };
    if (s.imports?.includes(module)) return t;
    if (s.npm?.some((n) => (n.endsWith('/') ? module.startsWith(n) : n === pkg || n === module))) return t;
  }
  return undefined;
}

/** Node.js built-in modules that matter for explanations (not separate technologies). */
const NODE_BUILTINS: Record<string, { name: string; role: string; what: string }> = {
  'node:sqlite': { name: 'node:sqlite', role: "Node.js's built-in way to talk to a SQLite database", what: 'A module built into Node.js for talking to SQLite databases.' },
  'node:crypto': { name: 'node:crypto', role: "Node.js's built-in cryptography (hashing, random tokens)", what: 'A module built into Node.js for cryptography: hashing passwords, comparing secrets, generating random tokens.' },
};

/** Database engines recognised from the driver a service imports. */
const DB_DRIVERS: Record<string, string> = {
  'node:sqlite': 'sqlite',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  '@libsql/client': 'sqlite',
  pg: 'postgresql',
  postgres: 'postgresql',
  mysql2: 'mysql',
  mysql: 'mysql',
  mongodb: 'mongodb',
  mongoose: 'mongodb',
  '@prisma/client': 'prisma',
};

const NODE_BUILTIN = new Set(builtinModules);
const realRoots = new Map<string, string>();
const realRoot = (root: string) => {
  let r = realRoots.get(root);
  if (!r) {
    try {
      r = realpathSync(root);
    } catch {
      r = root;
    }
    realRoots.set(root, r);
  }
  return r;
};
const packageCache = new Map<string, PackageInfo | null>();
interface PackageInfo {
  name: string;
  description?: string;
  version?: string;
  homepage?: string;
  /** A package that lives in this repository (a workspace), not one downloaded from npm. */
  local: boolean;
}

/**
 * The installed package an import refers to, found the way Node finds it (node_modules folders
 * from the importing file upwards). Path aliases (`@/x`, `~/x`) and missing packages give
 * nothing rather than a guess.
 */
export function packageOf(repoRoot: string, file: string, specifier: string): PackageInfo | undefined {
  if (/^(\.|\/|#|~\/|@\/|node:)/.test(specifier) || NODE_BUILTIN.has(specifier.split('/')[0])) return undefined;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined;
  for (let dir = path.dirname(path.join(repoRoot, file)); dir.startsWith(repoRoot); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    const key = manifest;
    if (packageCache.has(key)) {
      const hit = packageCache.get(key);
      if (hit) return hit;
    } else {
      let info: PackageInfo | null = null;
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const real = realpathSync(path.dirname(manifest));
        info = {
          name: pkg.name ?? name,
          description: typeof pkg.description === 'string' ? pkg.description.slice(0, 240) : undefined,
          version: pkg.version,
          homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
          local: real.startsWith(realRoot(repoRoot)) && !real.includes(`${path.sep}node_modules${path.sep}`),
        };
      } catch {
        info = null;
      }
      packageCache.set(key, info);
      if (info) return info;
    }
    if (dir === repoRoot) break;
  }
  return undefined;
}

export function fromRegistry(id: string, evidence: string, role?: string): TechRef | undefined {
  const t = byId.get(id);
  if (!t) return undefined;
  return {
    id: t.id,
    name: t.name,
    kind: t.kind as TechRef['kind'],
    evidence,
    role: role ?? t.effect,
    asset: t.logo ? `logo-${t.logo}` : (t.icon ?? undefined),
    logo: !!t.logo,
    what: t.what,
    effect: t.effect,
  };
}

export class TechDetector {
  private cache = new Map<string, unknown>();

  constructor(private analyzer: Analyzer) {}

  private memo<T>(key: string, fn: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key) as T;
  }

  /** The language a file is written in. */
  language(file: string): TechRef {
    return this.memo(`lang:${file}`, () => {
      const base = file.split('/').pop()!;
      const ext = base.slice(base.lastIndexOf('.'));
      const jsx = this.analyzer.fileHasJsx(file);
      if (ext === '.tsx') return fromRegistry('tsx', `${base} is a .tsx file${jsx ? ' and contains JSX tags' : ''}`, 'the language this part of the code is written in')!;
      if (/\.(m|c)?ts$/.test(ext)) return fromRegistry('typescript', `${base} is a .ts file`, 'the language this part of the code is written in')!;
      if (ext === '.jsx' || jsx) {
        return { ...fromRegistry('javascript', `${base} contains JSX tags`, 'the language this part of the code is written in')!, id: 'jsx-js', name: 'JavaScript + JSX' };
      }
      const known = TECHNOLOGIES.find((t) => (t.signals as { ext?: string[] }).ext?.includes(ext));
      return fromRegistry(known?.id ?? 'javascript', `${base} is a ${ext} file`, 'the language this part of the code is written in')!;
    });
  }

  /** Libraries and frameworks a file imports, as registered technologies. */
  libraries(file: string): TechRef[] {
    return this.memo(`libs:${file}`, () => {
      const base = file.split('/').pop();
      const out = new Map<string, TechRef>();
      for (const imp of this.analyzer.importsOf(file)) {
        const what = imp.names.length ? `${imp.names.slice(0, 3).join(', ')} from '${imp.module}'` : `'${imp.module}'`;
        const builtin = NODE_BUILTINS[imp.module];
        if (builtin && !out.has(imp.module)) {
          const id = imp.module.replace(':', '-');
          out.set(id, { id, name: builtin.name, kind: 'library', evidence: `${base} imports ${what}`, role: builtin.role, asset: 'library', what: builtin.what });
          continue;
        }
        const t = techForModule(imp.module);
        if (t) {
          if (!out.has(t.id) && t.category !== 'language') out.set(t.id, fromRegistry(t.id, `${base} imports ${what}`)!);
          continue;
        }
        // Any other package: described by its own package.json, so TraceNaut never needs a
        // registry entry to say what an imported library is.
        const pkg = packageOf(this.analyzer.ws.repoRoot, file, imp.module);
        if (pkg && !out.has(`pkg:${pkg.name}`)) {
          out.set(`pkg:${pkg.name}`, {
            id: `pkg:${pkg.name}`,
            name: pkg.name,
            kind: 'library',
            evidence: `${base} imports ${what}; the description comes from the package's own package.json`,
            role: pkg.local ? 'a package that is part of this project' : 'a library this code uses',
            asset: 'library',
            what: pkg.description,
            fromPackage: { version: pkg.version, homepage: pkg.homepage, local: pkg.local || undefined },
          });
        }
      }
      return [...out.values()];
    });
  }

  runtime(service: string): TechRef {
    const svc = this.analyzer.ws.services.find((s) => s.name === service);
    const how = this.analyzer.ws.origin === 'tracenaut.json' ? 'configured in tracenaut.json' : 'detected from package.json';
    if (svc?.kind === 'node') return fromRegistry('nodejs', `the "${service}" service is a Node.js service (${how})`, 'runs the server code')!;
    return { id: 'browser', name: 'Web browser', kind: 'runtime', evidence: `the "${service}" service runs in the browser (${how})`, role: 'runs the page and its code', asset: 'browser' };
  }

  /** Database engine (and driver) used by a service, from the driver its code imports. */
  database(service: string): { engine: TechRef; driver?: TechRef } | undefined {
    return this.memo(`db:${service}`, () => {
      const project = this.analyzer.project(service);
      for (const sf of project.userSourceFiles()) {
        const file = project.rel(sf);
        for (const imp of this.analyzer.importsOf(file)) {
          const engineId = DB_DRIVERS[imp.module];
          if (!engineId) continue;
          const base = file.split('/').pop();
          const how = `${base} imports ${imp.names.join(', ') || 'a driver'} from '${imp.module}'`;
          const engine = fromRegistry(engineId, how, 'stores the data and runs the queries')!;
          const builtin = NODE_BUILTINS[imp.module];
          const driverTech = builtin
            ? { id: imp.module.replace(':', '-'), name: builtin.name, kind: 'library' as const, evidence: how, role: builtin.role, asset: 'library', what: builtin.what }
            : techForModule(imp.module)?.id !== engineId
              ? fromRegistry(techForModule(imp.module)?.id ?? '', how)
              : undefined;
          return { engine, driver: driverTech };
        }
      }
      return undefined;
    });
  }

  http(evidence: string): TechRef {
    return { id: 'http', name: 'HTTP', kind: 'protocol', evidence, role: 'carries the request and the answer between browser and server', asset: 'protocol' };
  }

  json(evidence: string): TechRef {
    return { id: 'json', name: 'JSON', kind: 'data-format', evidence, role: 'writes the data as text both sides can read', asset: 'data' };
  }

  fetch(evidence: string): TechRef {
    return { id: 'fetch', name: 'fetch()', kind: 'browser-api', evidence, role: "the browser's built-in function for sending HTTP requests", asset: 'api' };
  }

  axios(evidence: string): TechRef {
    return fromRegistry('axios', evidence, 'a library that sends HTTP requests')!;
  }

  prisma(evidence: string): TechRef {
    return fromRegistry('prisma', evidence, 'turns model calls such as findUnique() into SQL')!;
  }

  sql(evidence: string): TechRef {
    return fromRegistry('sql', evidence, 'the language the server uses to ask the database for data')!;
  }

  /** Language + libraries for a set of files, de-duplicated, language first. */
  /**
   * `used`: packages the step's functions actually call into. Libraries known only from their
   * package.json are listed only when used, so a step does not list every import of its files.
   */
  forFiles(files: string[], used?: Set<string>): TechRef[] {
    const out = new Map<string, TechRef>();
    for (const f of files) {
      const lang = this.language(f);
      if (!out.has(lang.id)) out.set(lang.id, lang);
    }
    for (const f of files)
      for (const lib of this.libraries(f)) {
        if (out.has(lib.id)) continue;
        if (lib.fromPackage && !used?.has(lib.name)) continue;
        out.set(lib.id, lib);
      }
    return [...out.values()];
  }
}
