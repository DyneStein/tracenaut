import ts from 'typescript';
import type { ServiceProject } from './project.js';
import { type FnLike, isFnLike, lineCol } from './ast.js';
import { nextRoutes } from './next-routes.js';

/**
 * Route extraction. Express-style routes come from registration calls; Next.js routes
 * from the file system (see next-routes.ts).
 *
 * Express-style route extraction. Only receivers that resolve (through the type
 * checker) to a variable initialised with `express()` / `Router()` are considered,
 * so unrelated `.get()` / `.use()` calls (Maps, caches, query builders) are ignored.
 */

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);

export interface RouteRecord {
  service: string;
  method: string;
  /** Full path including mount prefixes, e.g. `/api/auth/login`. */
  path: string;
  localPath: string;
  file: string;
  line: number;
  col: number;
  receiver: string;
  framework: Lib | 'next';
  /** How the route is declared, as shown to the user: `router.get('/x')`, `export function GET` in app/x/route.ts. */
  declared: string;
  /** The registration: the `.get()` call, or the exported handler. */
  node: ts.Node;
  /** Middleware that runs before the handler, in order (app/router level first). */
  middleware: { expr: ts.Expression; scope: 'app' | 'router' | 'route' }[];
  handler: ts.Expression;
  /** False when the router is never mounted onto an app we could find. */
  mounted: boolean;
}

type Lib = 'express' | 'fastify' | 'hono' | 'koa-router';

interface Receiver {
  key: string;
  name: string;
  kind: 'app' | 'router';
  lib: Lib;
  /** koa-router's `new Router({ prefix: '/api' })`. */
  ownPrefix?: string;
  entries: Entry[];
  mounts: { parent: Receiver; prefix: string; pos: number; file: string }[];
}

type Entry =
  | { type: 'use'; prefix: string; middleware: ts.Expression[]; routers: Receiver[]; pos: number; file: string }
  | { type: 'route'; method: string; path: string; args: ts.Expression[]; call: ts.CallExpression; pos: number; file: string };

const cache = new WeakMap<ts.Program, RouteRecord[]>();

export function extractRoutes(project: ServiceProject): RouteRecord[] {
  const program = project.program();
  const hit = cache.get(program);
  if (hit) return hit;

  const checker = program.getTypeChecker();
  const receivers = new Map<string, Receiver>();

  // Fastify plugins: `app.register(plugin, { prefix })` hands `plugin` a scoped instance as its
  // first parameter; routes registered on that parameter live under the prefix.
  const pluginParams = new Map<ts.ParameterDeclaration, Receiver>();

  const keyOf = (decl: ts.Node) => `${decl.getSourceFile().fileName}:${decl.pos}`;
  const receiverAt = (decl: ts.Node, name: string, kind: Receiver['kind'], lib: Lib) => {
    const key = keyOf(decl);
    let r = receivers.get(key);
    if (!r) {
      r = { key, name, kind, lib, entries: [], mounts: [] };
      receivers.set(key, r);
    }
    return r;
  };

  const receiverFor = (expr: ts.Expression): Receiver | undefined => {
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
    // `sub.routes()` (koa-router) mounts the router itself.
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'routes') return receiverFor(expr.expression.expression);
    if (!ts.isIdentifier(expr)) return undefined;
    let sym = checker.getSymbolAtLocation(expr);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration;
    if (!decl) return undefined;
    if (ts.isParameter(decl)) return pluginParams.get(decl);
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    const made = createdBy(decl.initializer, checker);
    if (!made) return undefined;
    const r = receiverAt(decl, decl.name.getText(), made.kind, made.lib);
    if (made.prefix !== undefined) r.ownPrefix = made.prefix;
    return r;
  };

  // Two passes: the first finds Fastify `register()` calls, so routes on a plugin's
  // parameter are recognised even when the plugin's file is visited first.
  for (const pass of ['register', 'all'] as const)
  for (const sf of project.userSourceFiles()) {
    const file = project.rel(sf);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if (pass === 'register' ? method === 'register' : method === 'use' || method === 'route' || ROUTE_METHODS.has(method)) {
          const recv = receiverFor(n.expression.expression);
          if (recv) record(recv, method, n, file, sf);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  function record(recv: Receiver, method: string, call: ts.CallExpression, file: string, sf: ts.SourceFile) {
    const args = [...call.arguments];
    const first = args[0];
    const literal = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
    const pos = call.getStart(sf);
    const mount = (sub: Receiver, prefix: string) => sub.mounts.push({ parent: recv, prefix, pos, file });

    // Hono: `app.route('/api', sub)` mounts a sub-app. Fastify: `app.route({ method, url, handler })`.
    if (method === 'route') {
      if (recv.lib === 'hono' && literal !== undefined && args[1]) {
        const sub = receiverFor(args[1]);
        if (sub) mount(sub, literal);
      } else if (recv.lib === 'fastify' && first && ts.isObjectLiteralExpression(first)) {
        const prop = (k: string) => {
          const p = first.properties.find((x) => x.name?.getText() === k);
          return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
        };
        const m = prop('method');
        const url = prop('url') ?? prop('path');
        const handler = prop('handler');
        const methods = m && ts.isArrayLiteralExpression(m) ? m.elements : m ? [m] : [];
        if (url && handler && (ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url))) {
          const pre = prop('preHandler') ?? prop('onRequest');
          for (const me of methods) {
            if (!ts.isStringLiteral(me)) continue;
            recv.entries.push({ type: 'route', method: me.text.toUpperCase(), path: url.text, args: [...(pre ? [pre] : []), handler], call, pos, file });
          }
        }
      }
      return;
    }
    // Fastify: `app.register(plugin, { prefix: '/api' })`.
    if (method === 'register') {
      if (recv.lib !== 'fastify' || !first) return;
      const plugin = pluginFn(first);
      const param = plugin?.parameters[0];
      if (!plugin || !param) return;
      const opts = args[1] && ts.isObjectLiteralExpression(args[1]) ? args[1] : undefined;
      const prefixProp = opts?.properties.find((p) => p.name?.getText() === 'prefix');
      const prefix = prefixProp && ts.isPropertyAssignment(prefixProp) && ts.isStringLiteral(prefixProp.initializer) ? prefixProp.initializer.text : '';
      const sub = pluginParams.get(param) ?? receiverAt(param, param.name.getText(), 'router', 'fastify');
      pluginParams.set(param, sub);
      mount(sub, prefix);
      return;
    }
    if (method === 'use') {
      const rest = literal !== undefined ? args.slice(1) : args;
      const routers: Receiver[] = [];
      const middleware: ts.Expression[] = [];
      for (const a of rest) {
        // A router, or a whole sub-app (`app.use('/admin', adminApp)` in Express).
        const sub = receiverFor(a);
        if (sub && sub !== recv) routers.push(sub);
        else middleware.push(a);
      }
      // Hono's `app.use('/api/*', mw)` means the same as Express's `app.use('/api', mw)`.
      const prefix = (literal ?? '').replace(/\/\*$/, '');
      const entry: Entry = { type: 'use', prefix, middleware, routers, pos, file };
      recv.entries.push(entry);
      for (const sub of routers) mount(sub, prefix);
      return;
    }
    if (literal === undefined) return; // dynamic path: cannot be matched reliably
    recv.entries.push({ type: 'route', method: method.toUpperCase(), path: literal, args: args.slice(1), call, pos, file });
  }

  /** The function a Fastify plugin argument refers to (inline, a local function, or an import). */
  function pluginFn(e: ts.Expression): FnLike | undefined {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (isFnLike(e)) return e;
    // `fp(plugin)` (fastify-plugin) wraps a plugin without changing it.
    if (ts.isCallExpression(e) && e.arguments[0]) return pluginFn(e.arguments[0]);
    if (!ts.isIdentifier(e)) return undefined;
    let sym = checker.getSymbolAtLocation(e);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration;
    if (!decl) return undefined;
    if (isFnLike(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) return pluginFn(decl.initializer);
    return undefined;
  }

  // Middleware registered on `recv` before `pos` (same file) whose path covers `target`:
  // `use(mw)` covers everything, `use('/api', mw)` covers '/api' and anything below it.
  const covers = (prefix: string, target: string) => prefix === '' || prefix === '/' || target === prefix || target.startsWith(`${prefix.replace(/\/$/, '')}/`);
  const middlewareBefore = (recv: Receiver, file: string, pos: number, scope: 'app' | 'router', target = '', inclusive = false) =>
    recv.entries
      .filter((e): e is Extract<Entry, { type: 'use' }> => e.type === 'use' && e.file === file && (e.pos < pos || (inclusive && e.pos === pos)) && covers(e.prefix, target))
      .flatMap((e) => e.middleware.map((expr) => ({ expr, scope })));

  const prefixesOf = (recv: Receiver, seen = new Set<string>()): { prefix: string; middleware: RouteRecord['middleware']; mounted: boolean }[] => {
    const own = recv.ownPrefix ?? '';
    // A top-level app is reachable as is. A koa-router is attached to a Koa app with
    // `app.use(router.routes())`, which is not followed, so it is taken as mounted at '/'.
    if (seen.has(recv.key) || recv.mounts.length === 0) return [{ prefix: own, middleware: [], mounted: recv.kind === 'app' || recv.lib === 'koa-router' }];
    seen.add(recv.key);
    return recv.mounts.flatMap((m) =>
      prefixesOf(m.parent, new Set(seen)).map((p) => ({
        prefix: joinPath(joinPath(p.prefix, m.prefix), own),
        middleware: [...p.middleware, ...middlewareBefore(m.parent, m.file, m.pos, m.parent.kind, m.prefix, true)],
        mounted: p.mounted,
      })),
    );
  };

  const routes: RouteRecord[] = [];
  for (const recv of receivers.values()) {
    for (const e of recv.entries) {
      if (e.type !== 'route' || e.args.length === 0) continue;
      const sf = e.call.getSourceFile();
      const { line, col } = lineCol(sf, e.pos);
      const routeMiddleware = e.args.slice(0, -1).map((expr) => ({ expr, scope: 'route' as const }));
      for (const p of prefixesOf(recv)) {
        routes.push({
          service: project.service.name,
          method: e.method,
          path: joinPath(p.prefix, e.path),
          localPath: e.path,
          file: e.file,
          line,
          col,
          receiver: recv.name,
          framework: recv.lib,
          declared: `${recv.name}.${e.method.toLowerCase()}('${e.path}')`,
          node: e.call,
          middleware: [...p.middleware, ...middlewareBefore(recv, e.file, e.pos, recv.kind === 'app' ? 'app' : 'router', e.path), ...routeMiddleware],
          handler: e.args[e.args.length - 1],
          mounted: p.mounted,
        });
      }
    }
  }
  routes.push(...nextRoutes(project));
  cache.set(program, routes);
  return routes;
}

/**
 * What made a receiver: `express()`, `express.Router()`, `Router()`, `fastify()`,
 * `new Hono()`, `new Router()` from koa-router. The constructor must be imported (or
 * required) from that package, so a local `Router` class is not mistaken for one.
 */
function createdBy(init: ts.Expression, checker: ts.TypeChecker): { kind: 'app' | 'router'; lib: Lib; prefix?: string } | undefined {
  while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isAwaitExpression(init)) init = init.expression;
  if (!ts.isCallExpression(init) && !ts.isNewExpression(init)) return undefined;
  const callee = init.expression;
  const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  if (!ts.isIdentifier(root)) return undefined;
  const mod = moduleOf(root, checker);
  const name = member ?? root.text;
  if (mod === 'express') return member === 'Router' || (!member && name === 'Router') ? { kind: 'router', lib: 'express' } : !member ? { kind: 'app', lib: 'express' } : undefined;
  if (mod === 'fastify' && !member) return { kind: 'app', lib: 'fastify' };
  if (mod === 'hono' && ts.isNewExpression(init)) return { kind: 'app', lib: 'hono' };
  if ((mod === 'koa-router' || mod === '@koa/router') && ts.isNewExpression(init)) {
    const opts = init.arguments?.[0];
    const p = opts && ts.isObjectLiteralExpression(opts) ? opts.properties.find((x) => x.name?.getText() === 'prefix') : undefined;
    const prefix = p && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) ? p.initializer.text : undefined;
    return { kind: 'router', lib: 'koa-router', prefix };
  }
  // No module information (e.g. untyped CommonJS): fall back to the well-known spelling.
  if (mod === undefined) {
    const text = callee.getText();
    if (/^express$/.test(text)) return { kind: 'app', lib: 'express' };
    if (/^(express\.)?Router$/.test(text) && ts.isCallExpression(init)) return { kind: 'router', lib: 'express' };
  }
  return undefined;
}

/** The package an identifier was imported or required from, if it can be seen. */
function moduleOf(id: ts.Identifier, checker: ts.TypeChecker): string | undefined {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl) return undefined;
  let n: ts.Node | undefined = decl;
  while (n && !ts.isImportDeclaration(n) && !ts.isVariableDeclaration(n) && !ts.isSourceFile(n)) n = n.parent;
  if (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) return n.moduleSpecifier.text;
  if (n && ts.isVariableDeclaration(n) && n.initializer) {
    let init: ts.Expression = n.initializer;
    while (ts.isPropertyAccessExpression(init)) init = init.expression;
    if (ts.isCallExpression(init) && init.expression.getText() === 'require' && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) return init.arguments[0].text;
  }
  return undefined;
}

export function joinPath(a: string, b: string) {
  const joined = `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
  const clean = joined.replace(/\/+/g, '/');
  return clean.length > 1 ? clean.replace(/\/$/, '') : clean;
}

/**
 * Match a request (method + path pattern with `{x}` dynamic segments) to a route.
 * Returns a confidence note or undefined when they cannot correspond.
 */
export function matchRoute(method: string, reqPath: string, route: RouteRecord): string | undefined {
  if (route.method !== 'ALL' && method !== '?' && route.method !== method) return undefined;
  const req = splitPath(reqPath);
  const def = splitPath(route.path);
  for (let i = 0; i < def.length; i++) {
    const d = def[i];
    if (d === '*' || d.startsWith('*')) return 'wildcard route';
    const r = req[i];
    if (r === undefined) return undefined;
    if (d.startsWith(':')) continue;
    if (r.includes('{')) return undefined; // dynamic request segment vs literal route segment: unknown
    if (d !== r) return undefined;
  }
  if (req.length !== def.length) return undefined;
  return method === '?' ? 'path matches; request method unknown' : 'method and path match';
}

function splitPath(p: string) {
  return p.split('/').filter(Boolean);
}
