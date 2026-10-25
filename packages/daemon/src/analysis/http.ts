import ts from 'typescript';
import { type FnLike, fnName, isFnLike, isExternalFile } from './ast.js';

/**
 * Static description of HTTP requests issued from code.
 *
 * A `RequestSpec` describes a request in terms of one function's parameters (so it can be
 * reused at every call site of that function). Specs come from base clients (`fetch`,
 * `axios`) and compose through any number of wrapper layers:
 *
 *   component → get('/websites') → httpGet(getUrl(url)) → request('GET', buildPath(path)) → fetch(url, { method })
 *
 * Parts that cannot be known statically stay symbolic (`{param}` / `{expr}`) and are never
 * guessed. The one explicit assumption, a URL builder that puts an unknown base in front
 * of the path it is given, is marked (`base`) so the request is only ever *inferred* to
 * reach a route.
 */

/** `query` parts only affect the query string; `base` is an unknown prefix added by a builder. */
export type UrlPart = { lit: string } | { param: number; name: string; query?: boolean } | { dyn: string; query?: boolean; base?: boolean };
export type MethodSpec = { lit: string } | { param: number; prop?: string; fallback?: string } | { dyn: string };
export type BodySpec = { keys: string[] } | { param: number; prop?: string } | { dyn: true };

export interface RequestSpec {
  client: 'fetch' | 'axios';
  /** The fetch()/axios call that actually sends the request. */
  baseCall: ts.CallExpression;
  url: UrlPart[];
  method: MethodSpec;
  body?: BodySpec;
  json: boolean;
  /** Wrapper functions between the analysed function and the base call, outermost first. */
  chain: FnLike[];
}

export interface ResolvedRequest {
  method: string;
  /** Pattern with `{name}` for runtime parts, e.g. `/api/tasks/{id}` or `{base URL}/websites`. */
  pattern: string;
  /** True when every part of the URL and method was determined statically. */
  complete: boolean;
  /**
   * literal:    fully known.
   * parametric: method known; only whole path segments (e.g. an id) are filled at runtime.
   * prefixed:   method known; the path is known after an unknown base added by a builder.
   * partial:    something else is unknown (method, part of a segment, the path itself).
   */
  shape: 'literal' | 'parametric' | 'prefixed' | 'partial';
  /** The first wrapper the request was resolved through, if any. */
  via?: FnLike;
  chain: string[];
  fetchCall: ts.CallExpression;
  client: 'fetch' | 'axios';
  bodyKeys?: string[];
  format?: 'JSON';
  /** Name of the builder whose unknown base address is assumed in front of the path. */
  assumedBase?: string;
}

// ---------------------------------------------------------------------------- helpers

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function paramIndex(id: ts.Identifier, fn: FnLike | undefined, checker: ts.TypeChecker) {
  if (!fn) return -1;
  // In `{ method }` the name is the property; the value is the variable of the same name.
  const sym = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl) || decl.parent !== fn) return -1;
  return fn.parameters.indexOf(decl);
}

function isConst(decl: ts.VariableDeclaration) {
  return ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** The project function a callee refers to (function, arrow in a variable, useCallback(…)). */
function calleeFn(callee: ts.Expression, checker: ts.TypeChecker): FnLike | undefined {
  const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let sym = checker.getSymbolAtLocation(at);
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      return undefined;
    }
  }
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl || isExternalFile(decl.getSourceFile().fileName)) return undefined;
  if (isFnLike(decl)) return decl;
  const init = ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) ? decl.initializer && unwrap(decl.initializer) : undefined;
  if (!init) return undefined;
  if (isFnLike(init)) return init;
  if (ts.isCallExpression(init) && /useCallback$/.test(init.expression.getText()) && init.arguments[0] && isFnLike(unwrap(init.arguments[0]))) {
    return unwrap(init.arguments[0]) as FnLike;
  }
  return undefined;
}

function returnExprs(fn: FnLike): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn.body && isFnLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

function mentionsParam(e: ts.Node, idx: number, fn: FnLike, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && paramIndex(n, fn, checker) === idx) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(e);
  return found;
}

function stripQuery(parts: UrlPart[]): { path: UrlPart[]; query: boolean } {
  const path: UrlPart[] = [];
  for (const p of parts) {
    if ('lit' in p) {
      const q = p.lit.indexOf('?');
      if (q >= 0) {
        if (q > 0) path.push({ lit: p.lit.slice(0, q) });
        return { path, query: true };
      }
      path.push(p);
    } else if (p.query) return { path, query: true };
    else path.push(p);
  }
  return { path, query: false };
}

// ---------------------------------------------------------------------------- URL parts

/** Drop empty literals and merge neighbouring ones, so `{base}` and segment checks see real neighbours. */
function tidy(parts: UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  for (const p of parts) {
    if ('lit' in p) {
      if (!p.lit) continue;
      const prev = out[out.length - 1];
      if (prev && 'lit' in prev) {
        out[out.length - 1] = { lit: prev.lit + p.lit };
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

export function urlParts(expr: ts.Expression, fn: FnLike | undefined, checker: ts.TypeChecker, depth = 0): UrlPart[] {
  return tidy(rawUrlParts(expr, fn, checker, depth));
}

function rawUrlParts(expr: ts.Expression, fn: FnLike | undefined, checker: ts.TypeChecker, depth: number): UrlPart[] {
  if (depth > 6) return [{ dyn: expr.getText() }];
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ lit: expr.text }];
  if (ts.isTemplateExpression(expr)) {
    const parts: UrlPart[] = [{ lit: expr.head.text }];
    let inQuery = expr.head.text.includes('?');
    for (const span of expr.templateSpans) {
      const inner = urlParts(span.expression, fn, checker, depth + 1);
      parts.push(...(inQuery ? inner.map((p) => ('lit' in p ? p : { ...p, query: true })) : inner));
      parts.push({ lit: span.literal.text });
      if (span.literal.text.includes('?')) inQuery = true;
    }
    return parts;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...urlParts(expr.left, fn, checker, depth + 1), ...urlParts(expr.right, fn, checker, depth + 1)];
  }
  // `cond ? a : b`: when both branches share the same path and differ only in the query
  // string (`?${qs}` vs ''), the path is known.
  if (ts.isConditionalExpression(expr)) {
    const a = stripQuery(urlParts(expr.whenTrue, fn, checker, depth + 1));
    const b = stripQuery(urlParts(expr.whenFalse, fn, checker, depth + 1));
    if (render(a.path) === render(b.path)) return a.query || b.query ? [...a.path, { dyn: 'query', query: true }] : a.path;
  }
  if (ts.isIdentifier(expr)) {
    const idx = paramIndex(expr, fn, checker);
    if (idx >= 0) return [{ param: idx, name: expr.text }];
    const sym = checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isConst(decl)) return urlParts(decl.initializer, undefined, checker, depth + 1);
  }
  if (ts.isCallExpression(expr)) {
    const inlined = inlineBuilder(expr, fn, checker, depth);
    if (inlined) return inlined;
  }
  return [{ dyn: expr.getText() }];
}

/**
 * A small project function that builds a URL from its arguments (`buildPath(path, params)`,
 * `getUrl(url)`). When every return computes the same path, it is inlined exactly. When it
 * cannot be computed but one parameter reaches every return, the builder is assumed to put
 * an unknown base in front of that parameter; the result is marked `base` (an assumption).
 */
function inlineBuilder(call: ts.CallExpression, fn: FnLike | undefined, checker: ts.TypeChecker, depth: number): UrlPart[] | undefined {
  const g = calleeFn(call.expression, checker);
  if (!g || g === fn) return undefined;
  const rets = returnExprs(g);
  if (!rets.length || rets.length > 6) return undefined;
  const per = rets.map((r) => stripQuery(urlParts(r, g, checker, depth + 1)));
  const computable = per.every((p) => !p.path.some((x) => 'dyn' in x && !x.base));
  if (computable && per.every((p) => render(p.path) === render(per[0].path))) {
    const path = substitute(per[0].path, call.arguments, fn, checker, depth);
    return per.some((p) => p.query) ? [...path, { dyn: 'query', query: true }] : path;
  }
  const k = g.parameters.findIndex((_, idx) => rets.every((r) => mentionsParam(r, idx, g, checker)));
  const arg = k >= 0 ? call.arguments[k] : undefined;
  if (!arg) return undefined;
  const tail = stripQuery(urlParts(arg, fn, checker, depth + 1));
  if (!tail.path.length) return undefined;
  return [{ dyn: `${fnName(g)}()`, base: true }, ...tail.path];
}

function substitute(parts: UrlPart[], args: readonly ts.Expression[], fn: FnLike | undefined, checker: ts.TypeChecker, depth: number): UrlPart[] {
  const out: UrlPart[] = [];
  for (const p of parts) {
    if (!('param' in p)) {
      out.push(p);
      continue;
    }
    const arg = args[p.param];
    const inner = arg ? urlParts(arg, fn, checker, depth + 1) : [{ dyn: p.name }];
    out.push(...(p.query ? inner.map((x) => ('lit' in x ? x : { ...x, query: true })) : inner));
  }
  return tidy(out);
}

// ---------------------------------------------------------------------------- method and body

function methodFromExpr(expr: ts.Expression, fn: FnLike | undefined, checker: ts.TypeChecker): MethodSpec {
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { lit: expr.text.toUpperCase() };
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const left = methodFromExpr(expr.left, fn, checker);
    const right = methodFromExpr(expr.right, fn, checker);
    if ('param' in left && 'lit' in right) return { ...left, fallback: right.lit };
    return left;
  }
  if (ts.isIdentifier(expr)) {
    const idx = paramIndex(expr, fn, checker);
    if (idx >= 0) return { param: idx };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const idx = paramIndex(expr.expression, fn, checker);
    if (idx >= 0) return { param: idx, prop: expr.name.text };
  }
  return { dyn: expr.getText() };
}

/** Method in an options object; later properties override earlier ones, and `...options` may carry one. */
function methodInOptions(init: ts.Expression | undefined, fn: FnLike | undefined, checker: ts.TypeChecker, key = 'method', fallback = 'GET'): MethodSpec {
  if (!init) return { lit: fallback };
  init = unwrap(init);
  if (ts.isIdentifier(init)) {
    const idx = paramIndex(init, fn, checker);
    return idx >= 0 ? { param: idx, prop: key, fallback } : { dyn: init.getText() };
  }
  if (!ts.isObjectLiteralExpression(init)) return { dyn: init.getText() };
  let spec: MethodSpec = { lit: fallback };
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) {
      const e = unwrap(p.expression);
      const idx = ts.isIdentifier(e) ? paramIndex(e, fn, checker) : -1;
      spec = idx >= 0 ? { param: idx, prop: key, fallback: 'lit' in spec ? spec.lit : undefined } : { dyn: e.getText() };
    } else if (p.name?.getText() === key) {
      if (ts.isPropertyAssignment(p)) spec = methodFromExpr(p.initializer, fn, checker);
      else if (ts.isShorthandPropertyAssignment(p)) spec = methodFromExpr(p.name, fn, checker);
      else spec = { dyn: key };
    }
  }
  return spec;
}

function bodyFromExpr(e: ts.Expression, fn: FnLike | undefined, checker: ts.TypeChecker): { body: BodySpec; json: boolean } {
  e = unwrap(e);
  if (ts.isCallExpression(e) && /JSON\.stringify$/.test(e.expression.getText()) && e.arguments[0]) {
    return { body: bodyFromExpr(e.arguments[0], fn, checker).body, json: true };
  }
  if (ts.isObjectLiteralExpression(e)) return { body: { keys: e.properties.map((p) => p.name?.getText() ?? '…') }, json: false };
  // `options.body === undefined ? undefined : JSON.stringify(options.body)`: the branch that sends something.
  if (ts.isConditionalExpression(e)) {
    const empty = (x: ts.Expression) => /^(undefined|null|void 0)$/.test(unwrap(x).getText());
    if (empty(e.whenTrue) && !empty(e.whenFalse)) return bodyFromExpr(e.whenFalse, fn, checker);
    if (empty(e.whenFalse) && !empty(e.whenTrue)) return bodyFromExpr(e.whenTrue, fn, checker);
  }
  if (ts.isIdentifier(e)) {
    const idx = paramIndex(e, fn, checker);
    if (idx >= 0) return { body: { param: idx }, json: false };
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const idx = paramIndex(e.expression, fn, checker);
    if (idx >= 0) return { body: { param: idx, prop: e.name.text }, json: false };
  }
  return { body: { dyn: true }, json: false };
}

function bodyInOptions(init: ts.Expression | undefined, fn: FnLike | undefined, checker: ts.TypeChecker, key = 'body'): { body?: BodySpec; json: boolean } {
  if (!init) return { json: false };
  init = unwrap(init);
  const text = init.getText();
  const jsonHint = /JSON\.stringify|application\/json/.test(text);
  if (ts.isIdentifier(init)) {
    const idx = paramIndex(init, fn, checker);
    return idx >= 0 ? { body: { param: idx, prop: key }, json: jsonHint } : { json: jsonHint };
  }
  if (!ts.isObjectLiteralExpression(init)) return { json: jsonHint };
  let body: BodySpec | undefined;
  let json = jsonHint;
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) {
      const e = unwrap(p.expression);
      const idx = ts.isIdentifier(e) ? paramIndex(e, fn, checker) : -1;
      if (idx >= 0) body = { param: idx, prop: key };
    } else if (p.name?.getText() === key) {
      const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
      if (value) {
        const b = bodyFromExpr(value, fn, checker);
        body = b.body;
        json = json || b.json;
      }
    }
  }
  return { body, json };
}

// ---------------------------------------------------------------------------- base clients

export function isFetchCall(call: ts.CallExpression, checker: ts.TypeChecker) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && /^(window|globalThis|self)$/.test(callee.expression.getText())
      ? callee.name.text
      : undefined;
  if (name !== 'fetch') return false;
  const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  // Unresolved `fetch` (no DOM lib) is still the global; a user-defined `fetch` is not.
  return !decl || isExternalFile(decl.getSourceFile().fileName);
}

const AXIOS_NO_BODY = new Set(['get', 'delete', 'head', 'options']);
const AXIOS_BODY = new Set(['post', 'put', 'patch']);

/** `axios` itself, or an instance made with `axios.create({ baseURL })`; returns the base URL parts. */
function axiosTarget(expr: ts.Expression, checker: ts.TypeChecker): { base: UrlPart[] } | undefined {
  expr = unwrap(expr);
  if (!ts.isIdentifier(expr)) return undefined;
  // `import axios from 'axios'` / `const axios = require('axios')`, even when axios's types are not installed.
  const own = checker.getSymbolAtLocation(expr)?.declarations?.[0];
  if (own && importedFrom(own) === 'axios') return { base: [] };
  let sym = checker.getSymbolAtLocation(expr);
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      return undefined;
    }
  }
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl) return undefined;
  if (/node_modules\/axios\//.test(decl.getSourceFile().fileName)) return { base: [] };
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrap(decl.initializer);
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'create' && axiosTarget(init.expression.expression, checker)) {
      const cfg = init.arguments[0] && unwrap(init.arguments[0]);
      const baseProp = cfg && ts.isObjectLiteralExpression(cfg) ? cfg.properties.find((p) => p.name?.getText() === 'baseURL') : undefined;
      const base = baseProp && ts.isPropertyAssignment(baseProp) ? urlParts(baseProp.initializer, undefined, checker) : [];
      return { base };
    }
  }
  return undefined;
}

function importedFrom(decl: ts.Node): string | undefined {
  let n: ts.Node | undefined = decl;
  while (n && !ts.isImportDeclaration(n) && !ts.isVariableDeclaration(n) && !ts.isSourceFile(n)) n = n.parent;
  if (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) return n.moduleSpecifier.text;
  if (n && ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === 'require') {
    const a = n.initializer.arguments[0];
    return a && ts.isStringLiteral(a) ? a.text : undefined;
  }
  return undefined;
}

/** A direct HTTP client call (`fetch(…)`, `axios.get(…)`, `api.post(…)`), described in terms of `fn`'s parameters. */
export function clientCall(call: ts.CallExpression, fn: FnLike | undefined, checker: ts.TypeChecker): RequestSpec | undefined {
  if (isFetchCall(call, checker)) {
    const [urlArg, init] = call.arguments;
    if (!urlArg) return undefined;
    const b = bodyInOptions(init, fn, checker);
    return { client: 'fetch', baseCall: call, url: urlParts(urlArg, fn, checker), method: methodInOptions(init, fn, checker), body: b.body, json: b.json, chain: [] };
  }
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const target = axiosTarget(callee.expression, checker);
    const m = callee.name.text;
    if (target && (AXIOS_NO_BODY.has(m) || AXIOS_BODY.has(m))) {
      const [urlArg, dataArg] = call.arguments;
      if (!urlArg) return undefined;
      const body = AXIOS_BODY.has(m) && dataArg ? bodyFromExpr(dataArg, fn, checker).body : undefined;
      return { client: 'axios', baseCall: call, url: [...target.base, ...urlParts(urlArg, fn, checker)], method: { lit: m.toUpperCase() }, body, json: !!body, chain: [] };
    }
    if (target && m === 'request') return axiosConfigCall(call, call.arguments[0], target.base, fn, checker);
  }
  if (ts.isIdentifier(callee) && axiosTarget(callee, checker)) return axiosConfigCall(call, call.arguments[0], axiosTarget(callee, checker)!.base, fn, checker);
  return undefined;
}

function axiosConfigCall(call: ts.CallExpression, cfg: ts.Expression | undefined, base: UrlPart[], fn: FnLike | undefined, checker: ts.TypeChecker): RequestSpec | undefined {
  if (!cfg) return undefined;
  cfg = unwrap(cfg);
  if (!ts.isObjectLiteralExpression(cfg)) return undefined;
  const urlProp = cfg.properties.find((p) => p.name?.getText() === 'url');
  const url = urlProp && ts.isPropertyAssignment(urlProp) ? urlParts(urlProp.initializer, fn, checker) : [{ dyn: 'url' }];
  const dataProp = cfg.properties.find((p) => p.name?.getText() === 'data');
  const body = dataProp && ts.isPropertyAssignment(dataProp) ? bodyFromExpr(dataProp.initializer, fn, checker).body : undefined;
  return { client: 'axios', baseCall: call, url: [...base, ...url], method: methodInOptions(cfg, fn, checker), body, json: !!body, chain: [] };
}

// ---------------------------------------------------------------------------- wrappers and composition

const wrapperCache = new WeakMap<FnLike, RequestSpec | null>();
const inProgress = new Set<FnLike>();

/** Re-express `inner` (a spec of the called function) in terms of the caller `fn`, using the call's arguments. */
export function compose(inner: RequestSpec, call: ts.CallExpression, callee: FnLike, fn: FnLike | undefined, checker: ts.TypeChecker): RequestSpec {
  const args = call.arguments;
  const url = substitute(inner.url, args, fn, checker, 0);
  let method: MethodSpec = inner.method;
  if ('param' in inner.method) {
    const { param, prop, fallback } = inner.method;
    const arg = args[param];
    if (!arg) method = fallback ? { lit: fallback } : { dyn: 'method' };
    else if (!prop) method = methodFromExpr(arg, fn, checker);
    else {
      const m = methodInOptions(arg, fn, checker, prop, fallback ?? '');
      method = 'lit' in m && m.lit === '' ? (fallback ? { lit: fallback } : { dyn: prop }) : m;
    }
  }
  let body = inner.body;
  let json = inner.json;
  if (inner.body && 'param' in inner.body) {
    const arg = args[inner.body.param];
    if (!arg) body = undefined;
    else if (!inner.body.prop) {
      const b = bodyFromExpr(arg, fn, checker);
      body = b.body;
      json = json || b.json;
    } else {
      const b = bodyInOptions(arg, fn, checker, inner.body.prop);
      body = b.body;
      json = json || b.json;
    }
  }
  return { ...inner, url, method, body, json, chain: [callee, ...inner.chain] };
}

/**
 * A function is a request wrapper when it sends a request (directly or through other
 * wrappers) whose path depends on one of its own parameters.
 */
export function wrapperSpec(fn: FnLike, checker: ts.TypeChecker, depth = 0): RequestSpec | undefined {
  const hit = wrapperCache.get(fn);
  if (hit !== undefined) return hit ?? undefined;
  if (depth > 5 || inProgress.has(fn)) return undefined;
  inProgress.add(fn);
  let found: RequestSpec | undefined;
  try {
    for (const spec of requestsIn(fn, checker, depth)) {
      if (stripQuery(spec.url).path.some((p) => 'param' in p)) {
        found = spec;
        break;
      }
    }
  } finally {
    inProgress.delete(fn);
  }
  wrapperCache.set(fn, found ?? null);
  return found;
}

/** Requests sent inside `fn` (base calls and calls to wrappers), in terms of `fn`'s parameters. */
export function requestsIn(fn: FnLike, checker: ts.TypeChecker, depth = 0): RequestSpec[] {
  const out: RequestSpec[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n))) return;
    if (ts.isCallExpression(n)) {
      const direct = clientCall(n, fn, checker);
      if (direct) out.push(direct);
      else {
        const g = calleeFn(n.expression, checker);
        const inner = g && g !== fn ? wrapperSpec(g, checker, depth + 1) : undefined;
        if (g && inner) out.push(compose(inner, n, g, fn, checker));
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** Turn a spec (with any remaining parameters treated as runtime values) into what the journey shows. */
export function resolveSpec(spec: RequestSpec): ResolvedRequest {
  const methodKnown = 'lit' in spec.method || ('param' in spec.method && !!spec.method.fallback);
  const method = 'lit' in spec.method ? spec.method.lit : 'param' in spec.method && spec.method.fallback ? spec.method.fallback : '?';
  const { path } = stripQuery(spec.url);
  const base = path[0] && 'dyn' in path[0] && path[0].base ? path[0] : undefined;
  const rest = base ? path.slice(1) : path;
  let shape: ResolvedRequest['shape'] = shapeOf(rest, methodKnown);
  if (base && shape !== 'partial') shape = 'prefixed';
  const complete = spec.url.every((p) => 'lit' in p || p.query) && 'lit' in spec.method;
  const bodyKeys = spec.body && 'keys' in spec.body ? spec.body.keys : undefined;
  return {
    method,
    pattern: render(spec.url),
    complete,
    shape,
    via: spec.chain[0],
    chain: spec.chain.map((f) => fnName(f)),
    fetchCall: spec.baseCall,
    client: spec.client,
    bodyKeys,
    format: spec.json ? 'JSON' : undefined,
    assumedBase: base ? (base as { dyn: string }).dyn : undefined,
  };
}

function shapeOf(parts: UrlPart[], methodKnown: boolean): ResolvedRequest['shape'] {
  if (!methodKnown || parts.length === 0) return 'partial';
  if (parts.every((p) => 'lit' in p)) return 'literal';
  for (let i = 0; i < parts.length; i++) {
    if ('lit' in parts[i]) continue;
    const before = i > 0 ? parts[i - 1] : undefined;
    const after = parts[i + 1];
    const startsSegment = before && 'lit' in before && before.lit.endsWith('/');
    const endsSegment = !after || ('lit' in after && /^([/?#]|$)/.test(after.lit));
    if (!startsSegment || !endsSegment) return 'partial';
  }
  return 'parametric';
}

/** Shown for an unknown base address added by a URL builder; the space keeps it apart from `{variable}` parts. */
export const BASE_MARK = '{base URL}';

export function render(parts: UrlPart[]) {
  return parts
    .map((p) => {
      if ('lit' in p) return p.lit;
      if ('base' in p && p.base) return BASE_MARK;
      if (p.query) return 'dyn' in p && p.dyn === 'query' ? '?…' : '…';
      return 'param' in p ? `{${p.name}}` : `{${simplify(p.dyn)}}`;
    })
    .join('');
}

function simplify(text: string) {
  const id = /([A-Za-z_$][\w$]*)\s*\)?$/.exec(text);
  return id ? id[1] : 'expr';
}

/** Path part of a pattern; a leading origin (http://host:port) and query string are dropped. */
export function pathOf(pattern: string) {
  return pattern.replace(/^https?:\/\/[^/]+/, '').split('?')[0].split('#')[0] || '/';
}

/** Known path after an assumed base: `{base URL}/websites/{id}` → `/websites/{id}`. */
export function tailOf(pattern: string) {
  return pathOf(pattern.startsWith(BASE_MARK) ? pattern.slice(BASE_MARK.length) : pattern);
}
