import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StackResult, StackTech, TechKind } from '@tracenaut/protocol';
import { CATEGORIES, TECHNOLOGIES, supportOf } from '@tracenaut/assets';
import { IGNORED_DIRS, type Workspace } from './workspace.js';
import { packageOf } from './journey/tech.js';

/**
 * "Built with": which technologies the repository uses, each with the evidence that shows
 * it (a dependency in a manifest, files of a type, a configuration file, an import). Only
 * reads files; nothing is executed. Support levels come from the registry and say what
 * TraceNaut can do with each technology, which is not the same as the project using it.
 */

const MAX_FILES = 20000;
const MAX_IMPORT_SCAN = 3000;
const SOURCE = /\.(m|c)?[jt]sx?$/;

type Reg = (typeof TECHNOLOGIES)[number];
type Signals = { npm?: string[]; ext?: string[]; files?: string[]; py?: string[]; manifest?: string[]; imports?: string[]; text?: Record<string, string> };

interface Scan {
  files: string[]; // repo-relative
  truncated: boolean;
}

function walk(root: string): Scan {
  const files: string[] = [];
  let truncated = false;
  const visit = (dir: string, depth: number) => {
    if (depth > 10) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (IGNORED_DIRS.has(e) || (e.startsWith('.') && e !== '.babelrc')) continue;
      const full = path.join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full, depth + 1);
      else files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root, 0);
  return { files, truncated };
}

const read = (root: string, rel: string) => {
  try {
    return readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

const where = (rel: string) => (rel.includes('/') ? rel : `${rel} (repository root)`);

function globToRe(glob: string) {
  return new RegExp(`(^|/)${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
}

export function detectStack(ws: Workspace): StackResult {
  const t0 = Date.now();
  const root = ws.repoRoot;
  const { files, truncated } = walk(root);
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split('/').pop()!;
    byName.set(base, [...(byName.get(base) ?? []), f]);
  }

  // Dependencies from every package.json (workspaces, sub-apps).
  const deps = new Map<string, string[]>(); // package → manifests that list it
  for (const m of byName.get('package.json') ?? []) {
    try {
      const pkg = JSON.parse(read(root, m));
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) deps.set(name, [...(deps.get(name) ?? []), m]);
    } catch {
      // unreadable manifest: skip
    }
  }
  // Python requirements (requirements*.txt, pyproject.toml): names only.
  const py = new Map<string, string>();
  for (const f of files.filter((x) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(x))) {
    for (const m of read(root, f).toLowerCase().matchAll(/^\s*"?([a-z0-9_.-]+)/gm)) if (!py.has(m[1])) py.set(m[1], f);
  }
  // Imports of built-in modules such as `node:sqlite` (only signals that need it).
  const wantedImports = new Set(TECHNOLOGIES.flatMap((t) => (t.signals as Signals).imports ?? []));
  const imports = new Map<string, string>();
  if (wantedImports.size) {
    for (const f of files.filter((x) => SOURCE.test(x)).slice(0, MAX_IMPORT_SCAN)) {
      const text = read(root, f);
      for (const mod of wantedImports) if (!imports.has(mod) && (text.includes(`'${mod}'`) || text.includes(`"${mod}"`))) imports.set(mod, f);
    }
  }
  const extCount = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }

  const techs: StackTech[] = [];
  for (const t of TECHNOLOGIES as Reg[]) {
    const s = t.signals as Signals;
    const evidence: string[] = [];
    for (const n of s.npm ?? []) {
      const hits = n.endsWith('/') ? [...deps.keys()].filter((d) => d.startsWith(n)) : deps.has(n) ? [n] : [];
      for (const h of hits.slice(0, 2)) evidence.push(`${where(deps.get(h)![0])} depends on ${h}`);
    }
    for (const n of s.py ?? []) if (py.has(n)) evidence.push(`${py.get(n)} lists ${n}`);
    for (const f of s.files ?? []) {
      const hit = f.includes('*') ? files.find((x) => globToRe(f).test(x)) : byName.get(f)?.[0];
      if (hit) evidence.push(`found ${hit}`);
    }
    for (const m of s.manifest ?? []) {
      const hit = m.includes('*') ? files.find((x) => globToRe(m).test(x)) : byName.get(m)?.[0];
      if (hit && !(s.npm?.length || s.ext?.length)) evidence.push(`found ${hit}`);
    }
    for (const [file, needle] of Object.entries(s.text ?? {})) {
      const f = byName.get(file)?.[0];
      if (f && read(root, f).includes(needle)) evidence.push(`${f} mentions ${needle.replace(/'/g, '')}`);
    }
    for (const e of s.ext ?? []) {
      const n = extCount.get(e) ?? 0;
      if (n) evidence.push(`${n} ${e} file${n === 1 ? '' : 's'}`);
    }
    for (const m of s.imports ?? []) if (imports.has(m)) evidence.push(`${imports.get(m)} imports ${m}`);
    if (!evidence.length) continue;
    // Seeing only data files (e.g. a stray .db) is weak; it still counts, and the evidence says so.
    techs.push({
      id: t.id,
      name: t.name,
      kind: t.kind as TechKind,
      category: (CATEGORIES as Record<string, string>)[t.category] ?? t.category,
      asset: t.logo ? `logo-${t.logo}` : (t.icon ?? 'library'),
      logo: !!t.logo,
      what: t.what,
      effect: t.effect,
      evidence: [...new Set(evidence)].slice(0, 4),
      support: supportOf(t),
    });
  }
  // Dependencies no registry signal claimed: listed by name, in their own words.
  const claimed = new Set(TECHNOLOGIES.flatMap((t) => ((t.signals as Signals).npm ?? []).filter((n) => !n.endsWith('/'))));
  const prefixes = TECHNOLOGIES.flatMap((t) => ((t.signals as Signals).npm ?? []).filter((n) => n.endsWith('/')));
  const packages: NonNullable<StackResult['packages']> = [];
  for (const [name, manifests] of deps) {
    if (claimed.has(name) || prefixes.some((p) => name.startsWith(p)) || name.startsWith('@types/')) continue;
    const info = packageOf(root, manifests[0], name);
    packages.push({ name, description: info?.description, version: info?.version, local: info?.local || undefined, installed: !!info, manifest: manifests[0] });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { techs, packages, scanned: { files: files.length, ms: Date.now() - t0, truncated } };
}
