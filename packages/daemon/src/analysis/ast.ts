import ts from 'typescript';

export type FnLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

export function isFnLike(node: ts.Node): node is FnLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Start position of a function using the same convention as Babel (which produces the
 * runtime probe ids): `export` / `default` modifiers are not part of the function.
 * Keeping both sides identical lets runtime observations map to static nodes exactly.
 */
export function fnAnchor(fn: FnLike, sf: ts.SourceFile): number {
  const mods = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined;
  if (mods && mods.length) {
    const kept = mods.find((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword);
    if (kept) return kept.getStart(sf);
    let p = mods[mods.length - 1].end;
    while (p < sf.text.length && /\s/.test(sf.text[p])) p++;
    return p;
  }
  return fn.getStart(sf);
}

export function lineCol(sf: ts.SourceFile, pos: number) {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, col: lc.character };
}

export function posOf(sf: ts.SourceFile, line: number, col: number) {
  const starts = sf.getLineStarts();
  if (line < 1 || line > starts.length) return -1;
  const lineEnd = line < starts.length ? starts[line] - 1 : sf.text.length;
  return Math.min(starts[line - 1] + Math.max(0, col), lineEnd);
}

function unwrapParens(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent;
  return n.parent ?? n;
}

/** Mirrors the Babel plugin's naming so static and runtime views agree. */
export function fnName(fn: FnLike): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (ts.isConstructorDeclaration(fn)) return 'constructor';
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    return propName(fn.name);
  }
  const parent = unwrapParens(fn);
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = parent.left;
    if (ts.isIdentifier(left)) return left.text;
    if (ts.isPropertyAccessExpression(left)) return left.name.text;
  }
  if (ts.isPropertyAssignment(parent)) return propName(parent.name);
  if (ts.isPropertyDeclaration(parent)) return propName(parent.name);
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return `${parent.parent.name.getText()} handler`;
  }
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    if (ts.isIdentifier(callee) && callee.text === 'useCallback') {
      const decl = unwrapParens(parent);
      if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
    }
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : 'call';
    const first = parent.arguments[0];
    const routeArg = first && ts.isStringLiteral(first) ? `('${first.text}')` : '';
    return `${calleeName}${routeArg} callback`;
  }
  if (ts.isExportAssignment(parent)) return 'default';
  return '<anonymous>';
}

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return '<computed>';
}

export function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export type FnKind = 'component' | 'hook' | 'method' | 'function';

export function fnKind(fn: FnLike): FnKind {
  const name = fnName(fn);
  if (name.includes(' ')) return 'function';
  if (/^use[A-Z0-9]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name) && fn.body && containsJsx(fn.body)) return 'component';
  if (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) return 'method';
  return 'function';
}

/** Deepest node of `predicate` type that contains `pos`. */
export function findInnermost<T extends ts.Node>(sf: ts.SourceFile, pos: number, predicate: (n: ts.Node) => n is T): T | undefined {
  let best: T | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getFullStart() || pos > n.getEnd()) return;
    if (predicate(n) && pos >= n.getStart(sf)) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

/** A function-like whose Babel-compatible anchor is exactly `pos`, else the innermost one on that line. */
export function findFnAt(sf: ts.SourceFile, pos: number, nameHint?: string): FnLike | undefined {
  let exact: FnLike | undefined;
  const { line } = lineCol(sf, pos);
  const sameLine: FnLike[] = [];
  const visit = (n: ts.Node) => {
    if (exact) return;
    if (isFnLike(n)) {
      const anchor = fnAnchor(n, sf);
      if (anchor === pos) {
        exact = n;
        return;
      }
      if (lineCol(sf, anchor).line === line) sameLine.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (exact) return exact;
  if (nameHint) {
    const named = sameLine.find((f) => fnName(f) === nameHint);
    if (named) return named;
  }
  return sameLine[0];
}

export function enclosingFn(node: ts.Node): FnLike | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (isFnLike(n)) return n;
    n = n.parent;
  }
  return undefined;
}

/** The nearest enclosing function that looks like a component (skips inline callbacks). */
export function enclosingComponent(node: ts.Node): FnLike | undefined {
  let fn = enclosingFn(node);
  while (fn) {
    if (fnKind(fn) === 'component') return fn;
    fn = enclosingFn(fn);
  }
  return undefined;
}

export type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

export function isJsxOpening(n: ts.Node): n is JsxOpening {
  return ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);
}

export function jsxAt(sf: ts.SourceFile, pos: number): JsxOpening | undefined {
  let exact: JsxOpening | undefined;
  const visit = (n: ts.Node) => {
    if (exact || pos < n.getFullStart() || pos > n.getEnd()) return;
    if (isJsxOpening(n) && n.getStart(sf) === pos) {
      exact = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return exact ?? findInnermost(sf, pos, isJsxOpening);
}

/** The whole element (opening..closing) for an opening tag. */
export function jsxElementOf(opening: JsxOpening): ts.Node {
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

export function jsxTagName(opening: JsxOpening) {
  return opening.tagName.getText();
}

export function isHostTag(name: string) {
  return /^[a-z]/.test(name) || name.includes('-');
}

export function jsxAttr(opening: JsxOpening, name: string): ts.JsxAttribute | undefined {
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

export function jsxHasSpread(opening: JsxOpening) {
  return opening.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
}

export function jsxEventAttrs(opening: JsxOpening) {
  return opening.attributes.properties.filter(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && /^on[A-Z]/.test(p.name.getText()),
  );
}

export function staticAttrs(opening: JsxOpening): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue;
    const name = prop.name.getText();
    if (name.startsWith('data-tn-')) continue;
    const init = prop.initializer;
    out[name] = !init ? 'true' : ts.isStringLiteral(init) ? init.text : init.getText();
  }
  return out;
}

export function isExternalFile(fileName: string) {
  return fileName.includes('/node_modules/') || fileName.endsWith('.d.ts');
}

/** Human label for where an external declaration comes from. */
export function externalModuleOf(decl: ts.Node): string {
  const sf = decl.getSourceFile();
  let n: ts.Node | undefined = decl;
  while (n) {
    if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) return n.name.text;
    n = n.parent;
  }
  const f = sf.fileName;
  const lib = /\/typescript\/lib\/lib\.([\w.]+)\.d\.ts$/.exec(f);
  if (lib) return lib[1].startsWith('dom') ? 'Web API' : 'JavaScript built-in';
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f);
  if (nm) return nm[1].replace(/^@types\//, '').replace(/^(\w+)__(\w+)$/, '@$1/$2');
  return path(f);
}

function path(f: string) {
  return f.split('/').slice(-2).join('/');
}
