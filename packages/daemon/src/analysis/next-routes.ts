import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ServiceProject } from './project.js';
import type { RouteRecord } from './routes.js';
import { lineCol } from './ast.js';
import { toAbs } from '../workspace.js';

/**
 * Next.js routes come from the file system, not from registration calls:
 *
 *   app/api/websites/[websiteId]/route.ts  export async function GET(…)  →  GET /api/websites/:websiteId
 *   pages/api/users/[id].ts                export default function handler →  ALL /api/users/:id
 *
 * Route groups `(name)` and parallel slots `@name` are not part of the address; `[x]` is a
 * parameter, `[...x]` / `[[...x]]` catch the rest. Only used when the service depends on `next`.
 */

const HTTP_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ROUTE_FILE = /\/route\.(m|c)?[jt]sx?$/;
const PAGE_API = /\/pages\/api\/(.+)\.(m|c)?[jt]sx?$/;

function usesNext(project: ServiceProject) {
  for (let dir = toAbs(project.ws, project.service.root); dir.startsWith(project.ws.repoRoot); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if ({ ...pkg.dependencies, ...pkg.devDependencies }.next) return true;
      } catch {
        // Unreadable manifest: keep looking upwards.
      }
    }
    if (dir === project.ws.repoRoot) break;
  }
  return false;
}

function segmentToPath(seg: string): string | undefined {
  if (/^\(.*\)$/.test(seg) || seg.startsWith('@')) return undefined; // route group / parallel slot
  const catchAll = /^\[\[?\.\.\.(.+?)\]\]?$/.exec(seg);
  if (catchAll) return '*';
  const param = /^\[(.+)\]$/.exec(seg);
  if (param) return `:${param[1]}`;
  return seg;
}

function urlFromSegments(segs: string[]) {
  const parts = segs.map(segmentToPath).filter((x): x is string => x !== undefined);
  return `/${parts.join('/')}`;
}

/** The handler expression of an exported binding: a function, or the value of `export const GET = …`. */
function exportedHandlers(sf: ts.SourceFile): { name: string; node: ts.Node; handler: ts.Expression | ts.FunctionDeclaration }[] {
  const out: { name: string; node: ts.Node; handler: ts.Expression | ts.FunctionDeclaration }[] = [];
  const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && exported(st)) {
      const name = isDefault(st) ? 'default' : st.name?.text;
      if (name) out.push({ name, node: st, handler: st });
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.push({ name: d.name.text, node: d, handler: d.initializer });
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
      out.push({ name: 'default', node: st, handler: st.expression });
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      // `export { handler as GET }`
      for (const el of st.exportClause.elements) out.push({ name: el.name.text, node: el, handler: el.propertyName ?? el.name });
    }
  }
  return out;
}

export function nextRoutes(project: ServiceProject): RouteRecord[] {
  if (!usesNext(project)) return [];
  const routes: RouteRecord[] = [];
  for (const sf of project.userSourceFiles()) {
    const file = project.rel(sf);
    const local = `/${file.slice(project.service.root ? project.service.root.length + 1 : 0)}`;
    let url: string | undefined;
    let appRouter = false;
    if (ROUTE_FILE.test(local)) {
      const segs = local.split('/').filter(Boolean);
      const appAt = segs.indexOf('app');
      // `app/` at the root of the service or under `src/`.
      if (appAt !== 0 && !(appAt === 1 && segs[0] === 'src')) continue;
      url = urlFromSegments(segs.slice(appAt + 1, -1));
      appRouter = true;
    } else {
      const m = PAGE_API.exec(local);
      if (!m || !/^\/(src\/)?pages\/api\//.test(local)) continue;
      const segs = m[1].split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      url = urlFromSegments(['api', ...segs]);
    }
    for (const h of exportedHandlers(sf)) {
      const method = appRouter ? (HTTP_EXPORTS.has(h.name) ? h.name : undefined) : h.name === 'default' ? 'ALL' : undefined;
      if (!method) continue;
      const { line, col } = lineCol(sf, h.node.getStart(sf));
      routes.push({
        service: project.service.name,
        method,
        path: url,
        localPath: url,
        file,
        line,
        col,
        receiver: 'Next.js',
        framework: 'next',
        declared: appRouter ? `export function ${method} in ${file.split('/').slice(-2).join('/')}` : `export default handler in ${file}`,
        node: h.node,
        middleware: [],
        // A function declaration is resolved like an inline function (resolveExpr accepts any FnLike).
        handler: h.handler as ts.Expression,
        mounted: true,
      });
    }
  }
  return routes;
}
