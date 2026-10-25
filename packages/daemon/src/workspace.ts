import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type ServiceKind = 'browser' | 'node';

export interface ServiceConfig {
  name: string;
  /** Repo-relative root of the service ('' = repo root). */
  root: string;
  kind: ServiceKind;
}

export interface Workspace {
  repoRoot: string;
  services: ServiceConfig[];
  editor: string;
  /** How the services were determined, shown to the user. */
  origin: 'tracenaut.json' | 'detected';
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.turbo', '.cache']);

/**
 * Loads `tracenaut.json` from the repo root, or detects services by reading
 * package manifests. Detection only *reads* files; nothing in the repo is executed.
 */
export function loadWorkspace(repoRoot: string): Workspace {
  const abs = path.resolve(repoRoot);
  const configPath = path.join(abs, 'tracenaut.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const services: ServiceConfig[] = (raw.services ?? []).map((s: ServiceConfig) => ({
      name: String(s.name),
      root: normalizeRel(s.root ?? ''),
      kind: s.kind === 'node' ? 'node' : 'browser',
    }));
    if (services.length === 0) throw new Error('tracenaut.json must list at least one service');
    return { repoRoot: abs, services, editor: raw.editor ?? 'vscode', origin: 'tracenaut.json' };
  }
  return { repoRoot: abs, services: detectServices(abs), editor: 'vscode', origin: 'detected' };
}

function detectServices(repoRoot: string): ServiceConfig[] {
  const found: ServiceConfig[] = [];
  walkManifests(repoRoot, repoRoot, 0, found);
  if (found.length === 0) found.push({ name: 'app', root: '', kind: 'browser' });
  return found;
}

function walkManifests(repoRoot: string, dir: string, depth: number, out: ServiceConfig[]) {
  if (depth > 3) return;
  const manifest = path.join(dir, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const rel = normalizeRel(path.relative(repoRoot, dir));
      const name = (pkg.name ?? (rel || 'app')).replace(/^@[^/]+\//, '');
      if (deps.vite || deps.react || deps.next || deps.vue || deps.svelte) out.push({ name, root: rel, kind: 'browser' });
      else if (deps.express || deps.fastify || deps.koa || deps.hono) out.push({ name, root: rel, kind: 'node' });
    } catch {
      // Unreadable manifest: skip it rather than guess.
    }
  }
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    try {
      if (statSync(full).isDirectory()) walkManifests(repoRoot, full, depth + 1, out);
    } catch {
      // ignore unreadable entries
    }
  }
}

export function normalizeRel(p: string) {
  return p.split(path.sep).join('/').replace(/^\.\/?/, '').replace(/\/$/, '');
}

/** The service owning a repo-relative file: the one with the longest matching root. */
export function serviceForFile(ws: Workspace, relFile: string): ServiceConfig | undefined {
  let best: ServiceConfig | undefined;
  for (const s of ws.services) {
    const inside = s.root === '' || relFile === s.root || relFile.startsWith(`${s.root}/`);
    if (inside && (!best || s.root.length > best.root.length)) best = s;
  }
  return best;
}

export function toRel(ws: Workspace, absFile: string) {
  return normalizeRel(path.relative(ws.repoRoot, absFile));
}

export function toAbs(ws: Workspace, relFile: string) {
  const abs = path.resolve(ws.repoRoot, relFile);
  if (abs !== ws.repoRoot && !abs.startsWith(ws.repoRoot + path.sep)) {
    throw new Error(`Refusing to access a path outside the repository: ${relFile}`);
  }
  return abs;
}

export { IGNORED_DIRS };
