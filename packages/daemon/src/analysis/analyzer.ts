import ts from 'typescript';
import path from 'node:path';
import type {
  CodeMark,
  Evidence,
  GraphNode,
  HandlerInfo,
  InspectRequest,
  InspectResult,
  InspectedLevel,
  NodeDetail,
  Relation,
  RelationKind,
  SourceRef,
} from '@tracenaut/protocol';
import { type Workspace, serviceForFile, toAbs } from '../workspace.js';
import { ServiceProject } from './project.js';
import {
  type FnLike,
  type JsxOpening,
  enclosingComponent,
  enclosingFn,
  externalModuleOf,
  containsJsx,
  findFnAt,
  fnAnchor,
  fnKind,
  fnName,
  isExternalFile,
  isFnLike,
  isHostTag,
  isJsxOpening,
  jsxAt,
  jsxAttr,
  jsxElementOf,
  jsxEventAttrs,
  jsxHasSpread,
  jsxTagName,
  lineCol,
  posOf,
  staticAttrs,
} from './ast.js';
import { extId, located, parseId, parseLoc, unresId } from './ids.js';
import { type ResolvedRequest, BASE_MARK, clientCall, compose, pathOf, resolveSpec, tailOf, wrapperSpec } from './http.js';
import { type RouteRecord, extractRoutes, joinPath, matchRoute } from './routes.js';
import { type OrmCall, ormPhrase, prismaCall } from './orm.js';
import { codeView, highlightSnippet } from './code.js';
import { syntaxSpans } from './syntax.js';

interface Target {
  node: GraphNode;
  evidence: Evidence;
  note?: string;
  kind?: RelationKind;
  fn?: FnLike;
  /** The value is a prop of `component`; the caller decides how to follow it. */
  prop?: { name: string; component: FnLike };
}

const SQL_METHODS = new Set(['prepare', 'exec', 'query', 'execute', 'raw', 'unsafe']);
/** Methods that run an already-prepared statement (better-sqlite3, node:sqlite, pg, mysql2). */
const EXEC_METHODS = new Set(['get', 'all', 'run', 'iterate', 'each', 'pluck']);

/** SQL text of a string or template literal; runtime-filled parts are shown as `${…}`. */
function sqlText(e: ts.Expression): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `\${…}${s.literal.text}`).join('');
  return e.getText();
}

function isSqlText(e: ts.Expression) {
  const head = ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : ts.isTemplateExpression(e) ? e.head.text : undefined;
  return head !== undefined && SQL_START.test(head);
}
const SQL_START = /^\s*(select|insert|update|delete|create|with|pragma|alter|drop|replace|upsert)\b/i;
const BUBBLING = new Set([
  'onClick',
  'onDoubleClick',
  'onChange',
  'onInput',
  'onKeyDown',
  'onKeyUp',
  'onPointerDown',
  'onPointerUp',
  'onMouseDown',
  'onMouseUp',
]);

export class Analyzer {
  private projects = new Map<string, ServiceProject>();

  constructor(readonly ws: Workspace) {}

  // -------------------------------------------------------------------------
  // Projects & nodes

  project(serviceName: string) {
    let p = this.projects.get(serviceName);
    if (!p) {
      const svc = this.ws.services.find((s) => s.name === serviceName);
      if (!svc) throw new Error(`Unknown service: ${serviceName}`);
      p = new ServiceProject(this.ws, svc);
      this.projects.set(serviceName, p);
    }
    return p;
  }

  projectFor(relFile: string) {
    const svc = serviceForFile(this.ws, relFile);
    if (!svc) throw new Error(`${relFile} is not inside any configured service`);
    return this.project(svc.name);
  }

  private sourceOf(relFile: string) {
    const project = this.projectFor(relFile);
    const sf = project.sourceFile(relFile);
    if (!sf) throw new Error(`${relFile} is not part of the ${project.service.name} TypeScript/JavaScript program`);
    return { project, sf };
  }

  private rel(sf: ts.SourceFile) {
    return path.relative(this.ws.repoRoot, sf.fileName).split(path.sep).join('/');
  }

  private ref(sf: ts.SourceFile, node: ts.Node, pos = node.getStart(sf)): SourceRef {
    const file = this.rel(sf);
    const { line, col } = lineCol(sf, pos);
    const end = lineCol(sf, node.getEnd());
    return {
      service: serviceForFile(this.ws, file)?.name ?? '?',
      file,
      line,
      col,
      endLine: end.line,
      endCol: end.line === line ? end.col : undefined,
    };
  }

  fnNode(fn: FnLike): GraphNode {
    const sf = fn.getSourceFile();
    const anchor = fnAnchor(fn, sf);
    const source = this.ref(sf, fn, anchor);
    const kind = fnKind(fn);
    return {
      id: located('fn', source.file, source.line, source.col!),
      kind: kind === 'method' ? 'method' : kind,
      label: fnName(fn),
      source,
      expandable: true,
    };
  }

  private externalNode(name: string, module: string, detail?: string): GraphNode {
    return { id: extId(module, name), kind: 'external', label: name, detail: detail ?? module, expandable: false };
  }

  private unresolvedNode(sf: ts.SourceFile, node: ts.Node, label: string): GraphNode {
    const r = this.ref(sf, node);
    return { id: unresId(r.file, r.line, label), kind: 'unresolved', label, source: r, expandable: false };
  }

  // -------------------------------------------------------------------------
  // Resolution: expression → what it refers to

  private symbolDecl(project: ServiceProject, expr: ts.Node) {
    const checker = project.checker();
    const at = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    let sym = checker.getSymbolAtLocation(at);
    if (!sym) return undefined;
    if (at.parent && ts.isShorthandPropertyAssignment(at.parent)) {
      sym = checker.getShorthandAssignmentValueSymbol(at.parent) ?? sym;
    }
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return undefined;
      }
    }
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    return decl ? { sym, decl } : undefined;
  }

  /** Resolve an expression used as a value (handler, callee, argument) to its definition. */
  resolveExpr(project: ServiceProject, expr: ts.Expression, depth = 0): Target {
    const sf = expr.getSourceFile();
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
    if (isFnLike(expr)) return { node: this.fnNode(expr), evidence: 'static', fn: expr, note: 'defined inline' };
    if (ts.isCallExpression(expr)) {
      // fn.bind(null, id): the same function, with some arguments fixed in advance.
      if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'bind') {
        const inner = this.resolveExpr(project, expr.expression.expression, depth + 1);
        return { ...inner, note: [`${expr.expression.expression.getText()} with some arguments fixed in advance (.bind)`, inner.note].filter(Boolean).join('; ') };
      }
      const inner = this.resolveExpr(project, expr.expression, depth + 1);
      return { ...inner, note: `the value returned by calling ${expr.expression.getText()}()` };
    }
    if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) {
      return {
        node: this.unresolvedNode(sf, expr, expr.getText().slice(0, 60)),
        evidence: 'unresolved',
        note: 'computed expression; its value is only known at runtime',
      };
    }
    const found = this.symbolDecl(project, expr);
    if (!found) {
      return {
        node: this.unresolvedNode(sf, expr, expr.getText()),
        evidence: 'unresolved',
        note: 'TypeScript could not resolve this symbol (dynamic access or missing types)',
      };
    }
    return this.declTarget(project, found.decl, found.sym.getName(), expr, depth);
  }

  private declTarget(project: ServiceProject, decl: ts.Declaration, name: string, at: ts.Node, depth: number): Target {
    const sf = at.getSourceFile();
    const unresolved = (note: string): Target => ({ node: this.unresolvedNode(sf, at, name), evidence: 'unresolved', note });
    if (depth > 6) return unresolved('resolution depth exceeded');

    const declFile = decl.getSourceFile().fileName;
    if (isExternalFile(declFile)) {
      return { node: this.externalNode(name, externalModuleOf(decl)), evidence: 'static' };
    }
    if (isFnLike(decl)) return { node: this.fnNode(decl), evidence: 'static', fn: decl };

    if (ts.isVariableDeclaration(decl)) {
      let init = decl.initializer;
      while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
      if (!init) {
        if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) return unresolved('destructured value');
        return unresolved(`${name} is declared without an initializer`);
      }
      if (isFnLike(init)) return { node: this.fnNode(init), evidence: 'static', fn: init };
      if (ts.isCallExpression(init) && /^(React\.)?use(Callback|Memo)$/.test(init.expression.getText())) {
        const arg = init.arguments[0];
        if (arg && isFnLike(arg)) {
          if (init.expression.getText().endsWith('useCallback')) {
            return { node: this.fnNode(arg), evidence: 'static', fn: arg, note: 'memoised with useCallback' };
          }
          const body = ts.isArrowFunction(arg) && !ts.isBlock(arg.body) ? arg.body : undefined;
          if (body && isFnLike(body)) return { node: this.fnNode(body), evidence: 'static', fn: body, note: 'memoised with useMemo' };
        }
      }
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return this.resolveExpr(project, init, depth + 1);
      if (ts.isCallExpression(init)) {
        // const f = fn.bind(null, id): the same function.
        if (ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'bind') return this.resolveExpr(project, init, depth + 1);
        // const f = useDebouncedCallback((term) => …, 300) / debounce(fn) / throttle(fn): a library
        // wraps the function and decides when it runs. The wrapped function is what runs.
        const callee = this.resolveExpr(project, init.expression, depth + 1);
        const wrapped = init.arguments.find((a) => isFnLike(a) || ts.isIdentifier(a));
        if (callee.node.kind === 'external' && wrapped) {
          const t = this.resolveExpr(project, wrapped, depth + 1);
          if (t.fn) {
            return {
              ...t,
              evidence: t.evidence === 'unresolved' ? 'unresolved' : 'inferred',
              note: `the function handed to ${init.expression.getText().slice(0, 30)}() from ${callee.node.detail}, which decides when it runs (for example after a pause)`,
            };
          }
        }
      }
      return unresolved(`${name} holds a value computed at runtime (${init.getText().slice(0, 40)})`);
    }

    if (ts.isBindingElement(decl)) return this.bindingTarget(project, decl, name, at, depth);

    if (ts.isParameter(decl)) {
      return unresolved(`${name} is a parameter; its value is supplied by whoever calls ${enclosingFn(decl) ? fnName(enclosingFn(decl)!) : 'the function'}`);
    }
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
      const r = this.ref(decl.getSourceFile(), decl);
      return {
        node: { id: located('cls', r.file, r.line, r.col!), kind: 'class', label: name, source: r, expandable: true },
        evidence: 'static',
      };
    }
    if (ts.isPropertyAssignment(decl)) {
      const init = decl.initializer;
      if (isFnLike(init)) return { node: this.fnNode(init), evidence: 'static', fn: init };
      // `{ get: useCallback(async (url) => …, []) }`, e.g. an object returned by a custom hook.
      if (ts.isCallExpression(init) && /^(React\.)?useCallback$/.test(init.expression.getText()) && init.arguments[0] && isFnLike(init.arguments[0])) {
        const arg = init.arguments[0];
        return { node: this.fnNode(arg), evidence: 'static', fn: arg, note: 'memoised with useCallback' };
      }
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return this.resolveExpr(project, init, depth + 1);
    }
    if (ts.isShorthandPropertyAssignment(decl)) {
      const value = project.checker().getShorthandAssignmentValueSymbol(decl);
      const vdecl = value?.valueDeclaration ?? value?.declarations?.[0];
      if (vdecl) return this.declTarget(project, vdecl, name, at, depth + 1);
    }
    if (ts.isPropertySignature(decl) || ts.isMethodSignature(decl)) return this.implementationOf(project, decl, name, at, depth);
    return unresolved(`declared as ${ts.SyntaxKind[decl.kind]}; TraceNaut does not follow this kind of declaration yet`);
  }

  /** Destructured values: props, hook results, `useState` pairs. */
  private bindingTarget(project: ServiceProject, decl: ts.BindingElement, name: string, at: ts.Node, depth: number): Target {
    const sf = at.getSourceFile();
    const pattern = decl.parent;
    const holder = pattern.parent;
    const propName = decl.propertyName ? decl.propertyName.getText() : decl.name.getText();

    if (ts.isParameter(holder)) {
      const fn = enclosingFn(holder) ?? (holder.parent as FnLike);
      const isComponent = fnKind(fn) === 'component';
      return {
        node: this.unresolvedNode(sf, at, name),
        evidence: 'unresolved',
        note: isComponent
          ? `prop \`${propName}\` of <${fnName(fn)}>; its value comes from the parent that renders it`
          : `destructured from a parameter of ${fnName(fn)}`,
        prop: isComponent ? { name: propName, component: fn } : undefined,
      };
    }

    if (ts.isVariableDeclaration(holder) && holder.initializer) {
      const init = holder.initializer;
      const callee = ts.isCallExpression(init) ? init.expression.getText() : '';
      // const [state, formAction] = useActionState(createInvoice, …): React calls createInvoice.
      if (ts.isArrayBindingPattern(pattern) && /use(ActionState|FormState)$/.test(callee) && pattern.elements.indexOf(decl) === 1 && ts.isCallExpression(init) && init.arguments[0]) {
        const t = this.resolveExpr(project, init.arguments[0], depth + 1);
        return { ...t, note: [`the action given to ${callee}()`, t.note].filter(Boolean).join('; ') };
      }
      if (ts.isArrayBindingPattern(pattern) && /use(State|Reducer)$/.test(callee)) {
        const index = pattern.elements.indexOf(decl);
        const r = this.ref(sf, decl);
        return {
          node: {
            id: located('state', r.file, r.line, r.col!),
            kind: 'state',
            label: name,
            detail: index === 1 ? `state update (${callee})` : `state value (${callee})`,
            source: r,
            expandable: false,
          },
          evidence: 'static',
        };
      }
      if (ts.isObjectBindingPattern(pattern)) {
        const checker = project.checker();
        const prop = checker.getTypeAtLocation(init).getProperty(propName);
        const pdecl = prop?.valueDeclaration ?? prop?.declarations?.[0];
        if (pdecl) {
          const t = this.declTarget(project, pdecl, name, at, depth + 1);
          const via = ts.isCallExpression(init) ? `returned by ${init.expression.getText()}()` : `destructured from ${init.getText().slice(0, 30)}`;
          return { ...t, note: t.note ? `${via}; ${t.note}` : via };
        }
      }
    }
    return { node: this.unresolvedNode(sf, at, name), evidence: 'unresolved', note: 'destructured value whose source could not be traced' };
  }

  /**
   * A property declared only in a type (e.g. a context value's interface). We ask
   * TypeScript's "go to implementation" and report the result as *inferred*.
   */
  private implCache = new WeakMap<ts.Node, readonly ts.ImplementationLocation[]>();

  private implementationOf(project: ServiceProject, decl: ts.PropertySignature | ts.MethodSignature, name: string, at: ts.Node, depth: number): Target {
    const sf = at.getSourceFile();
    const owner = ts.isInterfaceDeclaration(decl.parent) || ts.isTypeLiteralNode(decl.parent) ? typeOwnerName(decl) : 'a type';
    const declRef = this.ref(decl.getSourceFile(), decl);
    const base = `declared in type ${owner} (${declRef.file}:${declRef.line})`;
    let impls = this.implCache.get(decl);
    if (!impls) this.implCache.set(decl, (impls = project.ls.getImplementationAtPosition(decl.getSourceFile().fileName, decl.name.getStart()) ?? []));
    for (const impl of impls) {
      const implSf = project.program().getSourceFile(impl.fileName);
      if (!implSf || isExternalFile(impl.fileName)) continue;
      const node = findNodeAtSpan(implSf, impl.textSpan.start);
      if (!node) continue;
      const holder = ts.isShorthandPropertyAssignment(node.parent) || ts.isPropertyAssignment(node.parent) ? node.parent : node;
      let t: Target | undefined;
      if (ts.isShorthandPropertyAssignment(holder)) t = this.declTarget(project, holder, name, at, depth + 1);
      else if (ts.isPropertyAssignment(holder)) {
        const init = holder.initializer;
        t = isFnLike(init) ? { node: this.fnNode(init), evidence: 'static', fn: init } : this.resolveExpr(project, init, depth + 1);
      }
      if (t && t.evidence !== 'unresolved') {
        const implRef = this.ref(implSf, holder);
        return {
          ...t,
          evidence: 'inferred',
          kind: 'implemented-by',
          note: `${base}; the object literal at ${implRef.file}:${implRef.line} provides it (TypeScript "go to implementation"). Which object is used at runtime is not proven statically.`,
        };
      }
    }
    // Fallback: object literals in user code that provide this property and whose type
    // is assignable to the declaring type (e.g. a context value built with useMemo).
    const candidates = this.assignableProviders(project, decl, name);
    if (candidates.length > 0 && candidates.length <= 3) {
      const [first] = candidates;
      const t = this.declTarget(project, first.prop, name, at, depth + 1);
      if (t.evidence !== 'unresolved') {
        const r = this.ref(first.prop.getSourceFile(), first.prop);
        return {
          ...t,
          evidence: 'inferred',
          kind: 'implemented-by',
          note: `${base}; ${candidates.length === 1 ? 'the only' : `one of ${candidates.length}`} object literal${candidates.length === 1 ? '' : 's'} of a compatible type providing \`${name}\` is at ${r.file}:${r.line}. Which object is used at runtime is not proven statically.`,
        };
      }
    }
    return { node: this.unresolvedNode(sf, at, name), evidence: 'unresolved', note: `${base}; no implementation found statically` };
  }

  private providerCache = new WeakMap<ts.Node, { prop: ts.ObjectLiteralElementLike }[]>();

  private assignableProviders(project: ServiceProject, decl: ts.PropertySignature | ts.MethodSignature, name: string) {
    const hit = this.providerCache.get(decl);
    if (hit) return hit;
    const result = this.computeAssignableProviders(project, decl, name);
    this.providerCache.set(decl, result);
    return result;
  }

  private computeAssignableProviders(project: ServiceProject, decl: ts.PropertySignature | ts.MethodSignature, name: string) {
    const checker = project.checker();
    const ownerNode = ts.isTypeLiteralNode(decl.parent) && ts.isTypeAliasDeclaration(decl.parent.parent) ? decl.parent.parent.name : ts.isInterfaceDeclaration(decl.parent) ? decl.parent.name : undefined;
    if (!ownerNode) return [];
    const ownerType = checker.getTypeAtLocation(ownerNode);
    const out: { prop: ts.ObjectLiteralElementLike }[] = [];
    for (const sf of project.userSourceFiles()) {
      if (!sf.text.includes(name)) continue;
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          const prop = n.properties.find((p) => p.name?.getText() === name);
          if (prop && checker.isTypeAssignableTo(checker.getTypeAtLocation(n), ownerType)) out.push({ prop });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Outgoing relations of a function

  private outgoingCache = new WeakMap<FnLike, Relation[]>();

  outgoing(fn: FnLike): Relation[] {
    const hit = this.outgoingCache.get(fn);
    if (hit) return hit;
    const result = this.computeOutgoing(fn);
    this.outgoingCache.set(fn, result);
    return result;
  }

  private computeOutgoing(fn: FnLike): Relation[] {
    const sf = fn.getSourceFile();
    const project = this.projectFor(this.rel(sf));
    const checker = project.checker();
    const rels: (Relation & { pos: number })[] = [];
    const seen = new Map<string, Relation & { pos: number }>();
    const add = (r: Relation, pos: number) => {
      const key = `${r.kind}|${r.target.id}`;
      const prev = seen.get(key);
      if (prev) {
        prev.sites = (prev.sites ?? 1) + 1;
        return;
      }
      const entry = { ...r, pos };
      seen.set(key, entry);
      rels.push(entry);
    };

    const visit = (n: ts.Node) => {
      if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n))) return;
      if (ts.isCallExpression(n)) this.callRelations(project, checker, fn, n, add);
      // SQL written as a tagged template: sql`SELECT …` (postgres.js, @vercel/postgres, Drizzle's
      // sql, Prisma's $queryRaw). The tag sends the text with the ${…} parts as parameters.
      else if (ts.isTaggedTemplateExpression(n) && isSqlText(n.template)) {
        add({ kind: 'queries', evidence: 'static', target: this.sqlNode(sf, n.template), note: `SQL written as a ${n.tag.getText().slice(0, 30)}\`…\` template; the \${…} parts are sent as separate values`, site: this.ref(sf, n.template) }, n.getStart(sf));
      }
      else if (ts.isNewExpression(n)) {
        const t = this.resolveExpr(project, n.expression);
        const thrown = ts.isThrowStatement(n.parent);
        add({ kind: 'constructs', evidence: t.evidence, target: t.node, note: thrown ? 'thrown as an error' : t.note, site: this.ref(sf, n.expression) }, n.getStart(sf));
      } else if (isJsxOpening(n)) {
        const tag = jsxTagName(n);
        if (!isHostTag(tag) && !/Fragment$/.test(tag)) {
          const t = this.resolveExpr(project, n.tagName as ts.Expression);
          if (t.node.kind !== 'external') {
            add({ kind: 'renders', evidence: t.evidence, target: t.node, note: t.note, site: this.ref(sf, n.tagName) }, n.getStart(sf));
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return rels.sort((a, b) => a.pos - b.pos).map(({ pos, ...r }) => r);
  }

  private callRelations(
    project: ServiceProject,
    checker: ts.TypeChecker,
    fn: FnLike,
    call: ts.CallExpression,
    add: (r: Relation, pos: number) => void,
  ) {
    const sf = call.getSourceFile();
    const callee = call.expression;
    if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return;
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const pos = nameNode.getStart(sf);
    const site = this.ref(sf, nameNode);

    // SQL text passed to a database API: `db.prepare('SELECT …')`, or a template with parts
    // filled in at runtime.
    // SQL text handed to the app's own query helper (`rawQuery(\`select …\`, params)`) counts too:
    // the text itself starts with a SQL keyword, so the call is sending a statement somewhere.
    {
      const arg = call.arguments[0];
      const known = ts.isPropertyAccessExpression(callee) && SQL_METHODS.has(callee.name.text);
      if (arg && isSqlText(arg)) {
        const via = known ? undefined : `SQL text passed to ${callee.getText().slice(0, 40)}(); TraceNaut did not follow how that function runs it`;
        add({ kind: 'queries', evidence: 'static', target: this.sqlNode(sf, arg), note: via, site: this.ref(sf, arg) }, pos);
      }
    }
    // Running a statement prepared elsewhere: `stmts.getAgent.get(id)` where
    // `stmts = { getAgent: db.prepare('SELECT …') }` (often in another module).
    if (ts.isPropertyAccessExpression(callee) && EXEC_METHODS.has(callee.name.text) && !ts.isCallExpression(callee.expression)) {
      const prepared = this.preparedSql(project, callee.expression);
      if (prepared) {
        add(
          {
            kind: 'queries',
            evidence: 'static',
            target: this.sqlNode(prepared.getSourceFile(), prepared),
            note: `statement prepared elsewhere and run here through ${callee.expression.getText().slice(0, 40)}`,
            site: this.ref(sf, callee.expression),
          },
          pos,
        );
      }
    }

    // ORM model operations (Prisma): `prisma.user.findUnique(…)`.
    const orm = prismaCall(call, this.ws, checker);
    if (orm) {
      add(
        {
          kind: 'queries',
          evidence: orm.evidence,
          target: this.ormNode(sf, call, orm),
          note:
            orm.evidence === 'static'
              ? `Prisma ${orm.op} on the ${orm.model} model (types from the generated client)`
              : `${orm.model} is a model in ${orm.schemaFile} and ${orm.op} is a Prisma operation; the generated client's types were not available to confirm it`,
          site,
        },
        pos,
      );
      return;
    }

    // Page navigation through a router or the browser: router.push('/x'), navigate('/x'),
    // location.assign('/x'). Recognised by the type of what is called, not by its name.
    const nav = navigationOf(call, checker);
    if (nav) {
      add(
        {
          kind: 'navigates',
          evidence: 'static',
          // One node per destination, so two router.push() calls stay two steps.
          target: this.externalNode(`${nav.method} ${nav.to ?? '…'}`, nav.router),
          note: nav.to ? `changes the page to ${nav.to}` : 'changes the page to an address computed at runtime',
          site,
        },
        pos,
      );
      return;
    }

    const direct = clientCall(call, fn, checker);
    if (direct) {
      const req = resolveSpec(direct);
      add(
        {
          kind: 'requests',
          evidence: req.shape === 'partial' ? 'unresolved' : 'static',
          target: this.httpNode(sf, call, req),
          note: requestNote(req, `in this ${req.client === 'axios' ? 'axios' : 'fetch()'} call`),
          site,
        },
        pos,
      );
      return;
    }

    const t = this.resolveExpr(project, callee);
    // TanStack Query: mutate()/mutateAsync() run the mutationFn given to useMutation().
    // (When types are unavailable the name alone is not trusted: mutationFnFor must still find
    // the useMutation({ mutationFn }) call the value comes from.)
    const tanstack = t.node.kind === 'external' && /tanstack|react-query/.test(t.node.detail ?? '');
    if ((tanstack || t.node.kind === 'unresolved') && /^(mutate|mutateAsync)$/.test(t.node.label)) {
      const found = this.mutationFnFor(project, callee);
      if (found) {
        const target = this.resolveExpr(project, found.fn);
        if (target.fn) {
          add(
            {
              kind: 'calls',
              evidence: target.evidence === 'unresolved' ? 'unresolved' : 'inferred',
              target: target.node,
              note: `${t.node.label}() from TanStack Query runs the mutationFn given to useMutation()${found.via ? ` in ${found.via}()` : ''}`,
              site,
            },
            pos,
          );
          return;
        }
      }
    }
    if (t.fn) {
      const wrapper = wrapperSpec(t.fn, checker);
      if (wrapper) {
        const req = resolveSpec(compose(wrapper, call, t.fn, fn, checker));
        add(
          {
            kind: 'requests',
            evidence: req.shape === 'partial' ? 'unresolved' : 'static',
            target: this.httpNode(sf, call, req),
            note: requestNote(req, `by following these arguments through ${req.chain.map((c) => `${c}()`).join(' → ')} to the ${req.client === 'axios' ? 'axios' : 'fetch()'} call`),
            site,
          },
          pos,
        );
      }
    }
    if (t.prop) {
      const supplied = this.propSuppliers(project, t.prop.component, t.prop.name);
      if (supplied.length) {
        for (const s of supplied) add({ ...s, kind: 'calls', site }, pos);
        return;
      }
    }
    add({ kind: t.kind ?? 'calls', evidence: t.evidence, target: t.node, note: t.note, site }, pos);
  }

  /** For a component prop, find what every usage of the component passes for it. */
  private supplierCache = new WeakMap<FnLike, Map<string, Relation[]>>();

  private propSuppliers(project: ServiceProject, component: FnLike, prop: string): Relation[] {
    let byProp = this.supplierCache.get(component);
    if (!byProp) this.supplierCache.set(component, (byProp = new Map()));
    const hit = byProp.get(prop);
    if (hit) return hit;
    const result = this.computePropSuppliers(project, component, prop);
    byProp.set(prop, result);
    return result;
  }

  private computePropSuppliers(project: ServiceProject, component: FnLike, prop: string): Relation[] {
    const nameNode = componentNameNode(component);
    if (!nameNode) return [];
    const sf = component.getSourceFile();
    const refs = project.ls.getReferencesAtPosition(sf.fileName, nameNode.getStart(sf)) ?? [];
    const out: Relation[] = [];
    const usages: { opening: JsxOpening; sf: ts.SourceFile }[] = [];
    for (const r of refs) {
      const rsf = project.program().getSourceFile(r.fileName);
      if (!rsf || isExternalFile(r.fileName)) continue;
      const node = findNodeAtSpan(rsf, r.textSpan.start);
      const opening = node?.parent;
      if (opening && isJsxOpening(opening) && opening.tagName === node) usages.push({ opening, sf: rsf });
    }
    for (const { opening, sf: usf } of usages.slice(0, 6)) {
      const attr = jsxAttr(opening, prop);
      const usageRef = this.ref(usf, opening);
      if (!attr?.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
      const t = this.resolveExpr(project, attr.initializer.expression);
      out.push({
        kind: 'calls',
        evidence: t.evidence === 'unresolved' ? 'unresolved' : 'inferred',
        target: t.node,
        note: `prop \`${prop}\` — ${usages.length === 1 ? 'the only' : `one of ${usages.length}`} <${fnName(component)}> usage${usages.length === 1 ? '' : 's'} (${usageRef.file}:${usageRef.line}) passes ${attr.initializer.expression.getText()}`,
      });
    }
    return out;
  }

  private sqlNode(sf: ts.SourceFile, literal: ts.Expression): GraphNode {
    const r = this.ref(sf, literal);
    return { id: located('sql', r.file, r.line, r.col!), kind: 'sql', label: sqlLabel(sqlText(literal)), source: r, expandable: true };
  }

  private ormNode(sf: ts.SourceFile, call: ts.CallExpression, orm: OrmCall): GraphNode {
    const r = this.ref(sf, call.expression);
    return { id: located('orm', r.file, r.line, r.col!), kind: 'orm-query', label: `${orm.model}.${orm.op}`, detail: `${orm.orm} · ${ormPhrase(orm)}`, source: r, expandable: true };
  }

  /** The ORM operation described by an orm node id. */
  ormAt(id: string): OrmCall | undefined {
    const ref = parseId(id);
    if (ref.t !== 'orm') return undefined;
    try {
      const { project, sf } = this.sourceOf(ref.file);
      const call = findInnermostCall(sf, posOf(sf, ref.line, ref.col));
      return call ? prismaCall(call, this.ws, project.checker()) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The SQL literal a statement variable/property was prepared from, if it can be followed. */
  private preparedSql(project: ServiceProject, expr: ts.Expression): ts.Expression | undefined {
    const found = this.symbolDecl(project, expr);
    const decl = found?.decl;
    if (!decl || isExternalFile(decl.getSourceFile().fileName)) return undefined;
    let init: ts.Expression | undefined =
      ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl) ? decl.initializer : undefined;
    while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init))) init = init.expression;
    if (!init || !ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) || !SQL_METHODS.has(init.expression.name.text)) return undefined;
    const arg = init.arguments[0];
    return arg && isSqlText(arg) ? arg : undefined;
  }

  private httpNode(sf: ts.SourceFile, call: ts.CallExpression, req: ResolvedRequest): GraphNode {
    const r = this.ref(sf, call);
    return {
      id: located('http', r.file, r.line, r.col!),
      kind: 'http-request',
      label: `${req.method} ${req.pattern}`,
      detail: req.via ? `via ${fnName(req.via)}()` : 'fetch()',
      source: r,
      expandable: true,
    };
  }

  /** Re-derive the request described by an http node id. */
  private requestAt(relFile: string, line: number, col: number) {
    const { project, sf } = this.sourceOf(relFile);
    const checker = project.checker();
    const pos = posOf(sf, line, col);
    const call = findInnermostCall(sf, pos);
    if (!call) throw new Error('The request call is no longer at this location (the file may have changed)');
    const fn = enclosingFn(call);
    const direct = clientCall(call, fn, checker);
    if (direct) return { project, sf, call, req: resolveSpec(direct) };
    const t = this.resolveExpr(project, call.expression);
    const wrapper = t.fn && wrapperSpec(t.fn, checker);
    if (!t.fn || !wrapper) return undefined;
    return { project, sf, call, req: resolveSpec(compose(wrapper, call, t.fn, fn, checker)) };
  }

  // -------------------------------------------------------------------------
  // Routes

  allRoutes(): RouteRecord[] {
    // Browser services are included because full-stack frameworks (Next.js) keep server routes beside the pages.
    return this.ws.services.flatMap((s) => extractRoutes(this.project(s.name)));
  }

  routeNode(r: RouteRecord): GraphNode {
    return {
      id: located('route', r.file, r.line, r.col),
      kind: 'http-route',
      label: `${r.method} ${r.path}`,
      detail: r.framework === 'next' ? `${r.service} · ${r.file.split('/').pop()} (Next.js)` : `${r.service} · ${r.receiver}.${r.method.toLowerCase()}()`,
      source: { service: r.service, file: r.file, line: r.line, col: r.col },
      expandable: true,
    };
  }

  /** Static routes matching a request; used by the http node and by runtime traces. */
  /**
   * `pages`: also consider pages (Next.js page.tsx). A data request written in code (fetch,
   * axios) targets API routes, not pages; at runtime a page request (navigation, RSC) does.
   */
  matchRoutes(method: string, url: string, opts: { pages?: boolean } = {}) {
    const candidates = () => this.allRoutes().filter((r) => opts.pages || r.kind !== 'page');
    const params = (r: RouteRecord) => r.path.split('/').filter((s) => s.startsWith(':') || s.includes('*')).length;
    const finish = (xs: { r: RouteRecord; why: string }[]) => {
      xs.sort((x, y) => params(x.r) - params(y.r));
      // Next.js picks a folder with a fixed name over a [parameter] folder, so a less
      // specific Next.js route is never reached when a more specific one matches.
      const next = xs.filter((x) => x.r.framework === 'next');
      if (next.length < 2) return xs;
      const best = Math.min(...next.map((x) => params(x.r)));
      return xs.filter((x) => x.r.framework !== 'next' || params(x.r) === best);
    };
    if (!url.startsWith(BASE_MARK)) {
      const p = pathOf(url);
      return finish(
        candidates()
          .map((r) => ({ r, why: matchRoute(method, p, r) }))
          .filter((x): x is { r: RouteRecord; why: string } => !!x.why),
      );
    }
    // Unknown base in front of a known path: a route matches when its path ends with that
    // path after a fixed prefix (base `/api` + `/websites/{id}` → `/api/websites/:websiteId`).
    // Because the base is assumed, a fixed request segment must meet a fixed route segment:
    // `/dashboard` is not taken to be the `:boardId` of `/api/boards/:boardId`.
    const tail = tailOf(url);
    const tailSegs = tail.split('/').filter(Boolean);
    const n = tailSegs.length;
    const out: { r: RouteRecord; why: string }[] = [];
    for (const r of candidates()) {
      const segs = r.path.split('/').filter(Boolean);
      if (segs.length < n) continue;
      const head = segs.slice(0, segs.length - n);
      if (head.some((x) => x.startsWith(':') || x.includes('*'))) continue;
      if (segs.slice(segs.length - n).some((x, i) => x.startsWith(':') && !tailSegs[i].includes('{'))) continue;
      const prefix = `/${head.join('/')}`;
      const why = matchRoute(method, joinPath(prefix, tail), r);
      if (why && !why.startsWith('wildcard')) out.push({ r, why: `${why}, assuming the unknown base address ${prefix === '/' ? 'adds nothing to the path' : `ends in ${prefix}`}` });
    }
    return finish(out);
  }

  /** The static route for a runtime-observed `METHOD /full/path` route string. */
  routeByRuntime(service: string, method: string, routePath: string) {
    return this.allRoutes().find((r) => r.service === service && (r.method === method || r.method === 'ALL') && r.path === routePath);
  }

  /**
   * A React Server Action: a function in a 'use server' file, or one whose body starts with
   * 'use server'. Called from the browser, it runs on the server (the framework sends a POST).
   */
  isServerAction(id: string): boolean {
    const fn = this.fnById(id);
    if (!fn) return false;
    const directive = (stmts: readonly ts.Statement[]) =>
      stmts.some((st, i) => i < 3 && ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression) && st.expression.text === 'use server');
    if (fn.body && ts.isBlock(fn.body) && directive(fn.body.statements)) return true;
    // File-level directive: only for top-level functions of that file.
    const sf = fn.getSourceFile();
    return directive(sf.statements) && !enclosingFn(fn);
  }

  /**
   * For mutate()/mutateAsync(): the mutationFn of the useMutation() call its object comes from,
   * either directly (const m = useMutation({ mutationFn })) or through one of the app's hooks
   * (const { mutateAsync } = useUpdateQuery(…), which calls useMutation inside).
   */
  private mutationFnFor(project: ServiceProject, callee: ts.Expression): { fn: ts.Expression; via?: string } | undefined {
    const sourceCall = (e: ts.Expression): ts.CallExpression | undefined => {
      const at = ts.isPropertyAccessExpression(e) ? e.expression : e;
      if (!ts.isIdentifier(at)) return undefined;
      const decl = project.checker().getSymbolAtLocation(at)?.valueDeclaration;
      const holder = decl && ts.isBindingElement(decl) ? decl.parent.parent : decl;
      const init = holder && ts.isVariableDeclaration(holder) ? holder.initializer : undefined;
      return init && ts.isCallExpression(init) ? init : undefined;
    };
    const optionsFn = (call: ts.CallExpression) => {
      const opts = call.arguments[0];
      if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
      const p = opts.properties.find((x) => x.name?.getText() === 'mutationFn');
      return p && ts.isPropertyAssignment(p) ? p.initializer : p && ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
    };
    const call = sourceCall(callee);
    if (!call) return undefined;
    if (/(^|\.)useMutation$/.test(call.expression.getText())) {
      const fn = optionsFn(call);
      return fn ? { fn } : undefined;
    }
    // One of the app's own hooks: look for the useMutation() call inside it.
    const hook = this.resolveExpr(project, call.expression).fn;
    if (!hook?.body) return undefined;
    let inner: ts.CallExpression | undefined;
    const visit = (n: ts.Node) => {
      if (inner) return;
      if (ts.isCallExpression(n) && /(^|\.)useMutation$/.test(n.expression.getText())) inner = n;
      else ts.forEachChild(n, visit);
    };
    visit(hook.body);
    const fn = inner && optionsFn(inner);
    return fn ? { fn, via: fnName(hook) } : undefined;
  }

  /** A function whose request address comes from its own parameters (fetch/axios wrapper). */
  isRequestWrapper(id: string): boolean {
    const fn = this.fnById(id);
    if (!fn) return false;
    try {
      return !!wrapperSpec(fn, this.projectFor(this.rel(fn.getSourceFile())).checker());
    } catch {
      return false;
    }
  }

  /** The literal address a function passes to redirect('/x'), if it does. */
  redirectTarget(id: string): string | undefined {
    const fn = this.fnById(id);
    let found: string | undefined;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && /(^|\.)redirect$/.test(n.expression.getText()) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) found = n.arguments[0].text;
      else ts.forEachChild(n, visit);
    };
    if (fn?.body) visit(fn.body);
    return found;
  }

  /** Node id of the function that handles a route, when it resolves to one in the project. */
  handlerNodeId(route: RouteRecord): string | undefined {
    try {
      const t = this.resolveExpr(this.project(route.service), route.handler);
      return t.fn ? this.fnNode(t.fn).id : undefined;
    } catch {
      return undefined;
    }
  }

  private routeRelations(route: RouteRecord): Relation[] {
    const project = this.project(route.service);
    const sf = route.node.getSourceFile();
    const rels: Relation[] = [];
    for (const m of route.middleware) {
      const expr = m.expr;
      const t = ts.isCallExpression(expr)
        ? { ...this.resolveExpr(project, expr.expression), note: `middleware created by ${expr.getText()}` }
        : this.resolveExpr(project, expr);
      rels.push({
        kind: 'middleware',
        evidence: t.evidence,
        target: t.node,
        note: [`${m.scope}-level middleware, runs before the handler`, t.note].filter(Boolean).join('; '),
        site: this.ref(expr.getSourceFile(), expr),
      });
    }
    const h = this.resolveExpr(project, route.handler);
    rels.push({ kind: 'handles', evidence: h.evidence, target: h.node, note: h.note, site: this.ref(sf, route.handler) });
    return rels;
  }

  // -------------------------------------------------------------------------
  // Structure queries used by journeys

  fnById(id: string): FnLike | undefined {
    const ref = parseId(id);
    if (ref.t !== 'fn') return undefined;
    try {
      const { sf } = this.sourceOf(ref.file);
      return findFnAt(sf, posOf(sf, ref.line, ref.col));
    } catch {
      return undefined;
    }
  }

  routeById(id: string) {
    const ref = parseId(id);
    if (ref.t !== 'route') return undefined;
    return this.allRoutes().find((x) => x.file === ref.file && x.line === ref.line && x.col === ref.col);
  }

  /** Relations used to walk a journey: a function's calls, a request's routes, a route's middleware and handler. */
  flowRelations(id: string): Relation[] {
    const ref = parseId(id);
    if (ref.t === 'fn') {
      const fn = this.fnById(id);
      return fn ? this.outgoing(fn) : [];
    }
    if (ref.t === 'http') {
      const found = this.requestAt(ref.file, ref.line, ref.col);
      if (!found || found.req.shape === 'partial') return [];
      return this.matchRoutes(found.req.method, found.req.pattern).map(({ r: route, why }) => ({
        kind: 'routes-to' as const,
        evidence: 'inferred' as const,
        target: this.routeNode(route),
        note: `${why}; assumes the request reaches ${route.service} with this path unchanged`,
      }));
    }
    if (ref.t === 'route') {
      const route = this.routeById(id);
      return route ? this.routeRelations(route) : [];
    }
    return [];
  }

  sqlTextAt(id: string): string | undefined {
    const ref = parseId(id);
    if (ref.t !== 'sql') return undefined;
    try {
      const { sf } = this.sourceOf(ref.file);
      const lit = findInnermostLiteral(sf, posOf(sf, ref.line, ref.col));
      return lit ? sqlText(lit) : undefined;
    } catch {
      return undefined;
    }
  }

  paramsOf(fn: FnLike): string[] {
    return fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText().replace(/\s+/g, ' ')));
  }

  /** The component a function is defined in (for "the LoginForm component's code runs"). */
  ownerComponent(fn: FnLike): string | undefined {
    if (fnKind(fn) === 'component') return fnName(fn);
    const c = enclosingComponent(fn);
    return c ? fnName(c) : undefined;
  }

  private jsxCache = new WeakMap<ts.SourceFile, boolean>();

  fileHasJsx(file: string): boolean {
    try {
      const { sf } = this.sourceOf(file);
      let v = this.jsxCache.get(sf);
      if (v === undefined) this.jsxCache.set(sf, (v = containsJsx(sf)));
      return v;
    } catch {
      return false;
    }
  }

  /** Non-relative module specifiers imported by a file, with the imported names. */
  importsOf(file: string): { module: string; names: string[] }[] {
    try {
      const { sf } = this.sourceOf(file);
      const out: { module: string; names: string[] }[] = [];
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const module = st.moduleSpecifier.text;
        if (module.startsWith('.') || module.startsWith('/')) continue;
        const names: string[] = [];
        const clause = st.importClause;
        if (clause?.name) names.push(clause.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.map((e) => e.name.text));
        out.push({ module, names });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** What a request sends: method, address, body fields and format, and which function sends it. */
  requestDetails(id: string) {
    const ref = parseId(id);
    if (ref.t !== 'http') return undefined;
    const found = this.requestAt(ref.file, ref.line, ref.col);
    if (!found) return undefined;
    const { req } = found;
    const fetchRef = this.ref(req.fetchCall.getSourceFile(), req.fetchCall);
    return {
      method: req.method,
      pattern: req.pattern,
      shape: req.shape,
      via: req.via ? fnName(req.via) : undefined,
      viaId: req.via ? this.fnNode(req.via).id : undefined,
      chain: req.chain,
      client: req.client,
      assumedBase: req.assumedBase,
      bodyKeys: req.bodyKeys,
      format: req.format,
      fetchFile: fetchRef.file,
      fetchLine: fetchRef.line,
    };
  }

  /**
   * Possible responses written in a route's handler and in the app's own middleware:
   * `res.status(401).json({ error })`, `res.json({ user })`, `res.cookie('name', …)`, …
   */
  responseDetails(routeId: string) {
    const route = this.routeById(routeId);
    if (!route) return { outcomes: [], cookies: [] as { name: string; action: 'sets' | 'clears' }[] };
    const project = this.project(route.service);
    const fns: { fn: FnLike; role: 'middleware' | 'handler' }[] = [];
    for (const m of route.middleware) {
      const t = ts.isCallExpression(m.expr) ? undefined : this.resolveExpr(project, m.expr);
      if (t?.fn) fns.push({ fn: t.fn, role: 'middleware' });
    }
    const h = this.resolveExpr(project, route.handler);
    if (h.fn) fns.push({ fn: h.fn, role: 'handler' });

    const outcomes: { status: number | '?'; sends?: string[]; from: string; role: 'middleware' | 'handler' }[] = [];
    const cookies: { name: string; action: 'sets' | 'clears' }[] = [];
    for (const { fn, role } of fns) {
      // pages/api handlers (`ALL`) use an Express-like `res`; everything else returns or sends a response.
      if (route.framework !== 'express' && !(route.framework === 'next' && route.method === 'ALL')) {
        for (const o of fetchStyleOutcomes(project, fn, route.framework)) outcomes.push({ ...o, from: o.from ?? fnName(fn), role });
        continue;
      }
      const resParam = fn.parameters[1];
      if (!resParam || !ts.isIdentifier(resParam.name)) continue;
      const res = resParam.name.text;
      const visit = (n: ts.Node) => {
        if (n !== fn && ts.isFunctionDeclaration(n)) return;
        if (ts.isCallExpression(n) && !(ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent))) {
          const chain = callChain(n);
          if (chain && chain.root === res) {
            let statuses: (number | '?')[] = [];
            let sends: string[] | undefined;
            let terminal = false;
            for (const c of chain.calls) {
              if (c.name === 'status' || c.name === 'sendStatus') {
                statuses = literalNumbers(c.args[0]);
                if (c.name === 'sendStatus') terminal = true;
              } else if (c.name === 'json') {
                terminal = true;
                const a = c.args[0];
                sends = a && ts.isObjectLiteralExpression(a) ? a.properties.map((p) => p.name?.getText() ?? '…') : a ? [a.getText()] : [];
              } else if (c.name === 'send' || c.name === 'end' || c.name === 'redirect' || c.name === 'render') {
                terminal = true;
                if (c.args[0] && c.name === 'send') sends = [c.args[0].getText().slice(0, 30)];
              } else if (c.name === 'cookie' || c.name === 'clearCookie') {
                const a = c.args[0];
                if (a && ts.isStringLiteral(a)) cookies.push({ name: a.text, action: c.name === 'cookie' ? 'sets' : 'clears' });
              }
            }
            if (terminal) for (const status of statuses.length ? statuses : [200 as const]) outcomes.push({ status, sends, from: fnName(fn), role });
          }
        }
        ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
    }
    return { outcomes, cookies };
  }

  // -------------------------------------------------------------------------
  // Node detail

  async node(id: string): Promise<NodeDetail> {
    const ref = parseId(id);
    if (ref.t === 'ext') {
      return {
        node: this.externalNode(ref.name, ref.module),
        facts: [{ label: 'Comes from', value: ref.module }],
        relations: [],
        notes: ['Library and platform code is not analysed. TraceNaut shows where your code uses it, not how it works inside.'],
      };
    }
    if (ref.t === 'unres') throw new Error('Unresolved nodes have no further detail');
    const { project, sf } = this.sourceOf(ref.file);
    const pos = posOf(sf, ref.line, ref.col);
    if (pos < 0) throw new Error('This location no longer exists (the file may have changed)');
    const absPath = toAbs(this.ws, ref.file);
    const service = project.service.name;

    switch (ref.t) {
      case 'fn': {
        const fn = findFnAt(sf, pos);
        if (!fn) throw new Error('No function at this location (the file may have changed)');
        const node = this.fnNode(fn);
        const relations = this.outgoing(fn);
        const span = this.ref(sf, fn);
        const facts = [{ label: 'Kind', value: describeKind(fnKind(fn)) }];
        const owner = enclosingFn(fn);
        if (owner) facts.push({ label: 'Defined inside', value: fnName(owner) });
        return {
          node,
          code: await this.view(sf, { service, file: ref.file, absPath, from: span.line, to: span.endLine!, focus: undefined, marks: marksFor(relations, ref.file) }),
          facts,
          relations,
          notes: relations.length === 0 ? ['This function does not call anything TraceNaut can see.'] : [],
        };
      }
      case 'jsx': {
        const opening = jsxAt(sf, pos);
        if (!opening) throw new Error('No JSX element at this location');
        const el = jsxElementOf(opening);
        const r = this.ref(sf, el);
        const relations: Relation[] = [];
        for (const attr of jsxEventAttrs(opening)) {
          const init = attr.initializer;
          if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
          const t = this.resolveExpr(project, init.expression);
          relations.push({ kind: 'handles', evidence: t.evidence, target: t.node, note: `${attr.name.getText()}${t.note ? ` — ${t.note}` : ''}`, site: this.ref(sf, attr) });
        }
        const tag = jsxTagName(opening);
        if (!isHostTag(tag)) {
          const t = this.resolveExpr(project, opening.tagName as ts.Expression);
          relations.unshift({ kind: 'renders', evidence: t.evidence, target: t.node, note: t.note });
        }
        return {
          node: { id, kind: 'element', label: `<${tag}>`, source: r, expandable: true },
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line - 3, to: r.endLine! + 3, focus: { from: r.line, to: r.endLine! }, marks: marksFor(relations, ref.file) }),
          facts: Object.entries(staticAttrs(opening)).map(([label, value]) => ({ label, value })),
          relations,
          notes: [],
        };
      }
      case 'http': {
        const found = this.requestAt(ref.file, ref.line, ref.col);
        if (!found) throw new Error('No request call at this location');
        const { req, call } = found;
        const r = this.ref(sf, call);
        const matches = req.shape === 'partial' ? [] : this.matchRoutes(req.method, req.pattern);
        const relations: Relation[] = matches.map(({ r: route, why }) => ({
          kind: 'routes-to',
          evidence: 'inferred',
          target: this.routeNode(route),
          note: `${why}. Assumes the request reaches ${route.service} with this path unchanged (e.g. via a dev proxy).${route.mounted ? '' : ' The router was not found mounted on an app.'}`,
        }));
        const notes: string[] = [];
        if (req.shape === 'parametric') notes.push('Segments in {braces} are filled in at runtime (e.g. an id); the method and route shape are known statically.');
        if (req.shape === 'prefixed') notes.push(`${req.assumedBase} adds a base address that is only known at runtime (often from configuration). The path after it is known; routes are matched on that path, so the match is an inference.`);
        if (req.shape === 'partial') notes.push('Part of this request is only known at runtime; values in {braces} are placeholders, not guesses, so no route is matched.');
        if (relations.length === 0) notes.push('No route in the configured backend services matches this request statically. Use "Trace next action" to observe where it actually goes.');
        const fetchRef = this.ref(req.fetchCall.getSourceFile(), req.fetchCall);
        return {
          node: this.httpNode(sf, call, req),
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line - 2, to: r.endLine! + 2, focus: { from: r.line, to: r.endLine! }, marks: [] }),
          facts: [
            { label: 'Method', value: req.method },
            { label: 'URL', value: req.pattern },
            { label: req.client === 'axios' ? 'axios call' : 'fetch() call', value: `${fetchRef.file}:${fetchRef.line}` },
            ...(req.chain.length ? [{ label: 'Through', value: req.chain.map((c) => `${c}()`).join(' → ') }] : []),
            ...(req.bodyKeys?.length ? [{ label: 'Body fields', value: req.bodyKeys.join(', ') }] : []),
          ],
          relations,
          notes,
        };
      }
      case 'route': {
        const route = this.allRoutes().find((x) => x.file === ref.file && x.line === ref.line && x.col === ref.col);
        if (!route) throw new Error('No route registration at this location');
        const r = this.ref(sf, route.node);
        const relations = this.routeRelations(route);
        return {
          node: this.routeNode(route),
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line - 1, to: r.endLine! + 1, focus: { from: r.line, to: r.endLine! }, marks: marksFor(relations, ref.file) }),
          facts: [
            { label: 'Method', value: route.method },
            { label: 'Full path', value: route.path },
            { label: 'Declared as', value: route.declared },
          ],
          relations,
          notes: [
            ...(route.mounted ? [] : ['This router is never mounted on an Express app that TraceNaut could find, so the full path may be incomplete.']),
            ...(route.framework === 'next'
              ? ['Next.js builds this address from the file’s folder path; folders in (parentheses) are left out and [brackets] are filled in from the address. Next.js middleware and basePath/rewrites from next.config are not followed.']
              : []),
          ],
        };
      }
      case 'sql': {
        const lit = findInnermostLiteral(sf, pos);
        if (!lit) throw new Error('No SQL literal at this location');
        const r = this.ref(sf, lit);
        const call = lit.parent;
        const text = sqlText(lit);
        const tables = sqlTables(text);
        return {
          node: this.sqlNode(sf, lit),
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line - 2, to: r.endLine! + 2, focus: { from: r.line, to: r.endLine! }, marks: [] }),
          facts: [
            { label: 'Operation', value: text.trim().split(/\s+/)[0].toUpperCase() },
            ...(tables.length ? [{ label: 'Tables', value: tables.join(', ') }] : []),
            ...(ts.isCallExpression(call) ? [{ label: 'Executed via', value: `${call.expression.getText()}()` }] : []),
          ],
          relations: [],
          notes: ['SQL text found statically. Whether and with which parameters it runs is only visible in a runtime trace (parameter values are never captured).'],
        };
      }
      case 'orm': {
        const call = findInnermostCall(sf, pos);
        const orm = call && prismaCall(call, this.ws, project.checker());
        if (!call || !orm) throw new Error('No ORM call at this location');
        const r = this.ref(sf, call);
        return {
          node: this.ormNode(sf, call, orm),
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line - 2, to: r.endLine! + 2, focus: { from: r.line, to: r.endLine! }, marks: [] }),
          facts: [
            { label: 'Library', value: orm.orm },
            { label: 'Model', value: `${orm.model} (declared in ${orm.schemaFile})` },
            { label: 'Operation', value: `${orm.op} — ${ormPhrase(orm)}` },
          ],
          relations: [],
          notes: [
            'Prisma turns this call into SQL when it runs. The exact SQL is generated by Prisma and is only visible in a runtime trace.',
            ...(orm.evidence === 'inferred' ? ["The generated Prisma client was not available to TypeScript (run `prisma generate`), so this rests on the model and operation names matching the schema."] : []),
          ],
        };
      }
      case 'cls': {
        const decl = findInnermostClass(sf, pos);
        if (!decl) throw new Error('No class at this location');
        const r = this.ref(sf, decl);
        const relations: Relation[] = (decl.members as readonly ts.Node[]).filter(isFnLike).map((m) => ({ kind: 'calls' as const, evidence: 'static' as const, target: this.fnNode(m), note: 'member' }));
        const heritage = decl.heritageClauses?.map((h) => h.getText()).join(' ');
        return {
          node: { id, kind: 'class', label: decl.name?.text ?? 'class', source: r, expandable: true },
          code: await this.view(sf, { service, file: ref.file, absPath, from: r.line, to: r.endLine!, marks: [] }),
          facts: heritage ? [{ label: 'Heritage', value: heritage }] : [],
          relations,
          notes: [],
        };
      }
      case 'state':
        throw new Error('State bindings have no further detail');
    }
  }

  /** Functions/components that reference a function node: "who calls this?". */
  callers(id: string): Relation[] {
    const ref = parseId(id);
    if (ref.t !== 'fn') return [];
    const { project, sf } = this.sourceOf(ref.file);
    const fn = findFnAt(sf, posOf(sf, ref.line, ref.col));
    if (!fn) return [];
    const nameNode = componentNameNode(fn);
    if (!nameNode) return [];
    const refs = project.ls.getReferencesAtPosition(sf.fileName, nameNode.getStart(sf)) ?? [];
    const out = new Map<string, Relation>();
    for (const r of refs) {
      const isDeclaration = r.fileName === sf.fileName && r.textSpan.start === nameNode.getStart(sf);
      if (isDeclaration || isExternalFile(r.fileName)) continue;
      const rsf = project.program().getSourceFile(r.fileName);
      const node = rsf && findNodeAtSpan(rsf, r.textSpan.start);
      if (!rsf || !node) continue;
      const parent = node.parent;
      const isCall = (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent));
      const isJsx = isJsxOpening(parent) && parent.tagName === node;
      const isValue =
        ts.isJsxExpression(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
        (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression));
      if (!isCall && !isJsx && !isValue) continue;
      const caller = namedEnclosingFn(node);
      if (!caller) continue;
      const target = this.fnNode(caller);
      const key = target.id;
      if (out.has(key)) {
        out.get(key)!.sites = (out.get(key)!.sites ?? 1) + 1;
        continue;
      }
      out.set(key, {
        kind: isJsx ? 'renders' : 'calls',
        evidence: isValue && !isCall ? 'inferred' : 'static',
        target,
        note: isJsx ? 'renders it' : isCall ? 'calls it' : 'references it as a value (a callback, prop or object member) — not a direct call',
        site: this.ref(rsf, node),
      });
    }
    return [...out.values()];
  }

  // -------------------------------------------------------------------------
  // Inspect: a runtime element chain → source + handlers

  async inspect(req: InspectRequest): Promise<InspectResult> {
    const notes: string[] = [];
    const chain = req.chain.slice(0, 24);
    if (chain.length === 0) {
      return {
        element: req.element,
        levels: [],
        primary: 0,
        handlers: [],
        notes: ['This element carries no TraceNaut source location. It may be rendered by a library, injected outside React, or come from a file that is not instrumented.'],
      };
    }

    const resolved = chain.map((entry) => this.resolveLevel(entry));
    const levels: InspectedLevel[] = resolved.map((r) => r.level);

    // Prefer the usage site when the clicked host element is just the root of a reusable component.
    let primary = 0;
    const host = resolved[0];
    const parentUse = resolved[1];
    if (host?.opening && parentUse?.entry.type === 'component' && host.ownerFn && parentUse.definitionFn === host.ownerFn) primary = 1;

    const handlers: HandlerInfo[] = [];
    // A click on something inside a submit button (its icon or label) is a click on the button,
    // so it submits the form too. The nearest button above the clicked element decides.
    const enclosingButton = resolved.find((l, i) => (i > 0 || req.leaf) && l.entry.type === 'host' && (l.entry.name === 'button' || l.entry.name === 'form'));
    const buttonType = enclosingButton?.opening ? (staticAttrs(enclosingButton.opening).type ?? '').toLowerCase() : '';
    const isSubmitControl = isSubmit(req.element) || (enclosingButton?.entry.name === 'button' && (buttonType === '' || buttonType === 'submit'));
    for (let i = 0; i < resolved.length; i++) {
      const lvl = resolved[i];
      // Plain elements, and usages of library components (<Form onSubmit={…}> from a UI kit):
      // the app hands the library a function under an event-like name.
      const libraryComponent = lvl.entry.type === 'component' && lvl.level.definition?.kind === 'external';
      if ((lvl.entry.type !== 'host' && !libraryComponent) || !lvl.opening) continue;
      // Event handlers, plus React form actions: <form action={fn}> / <button formAction={fn}>
      // (a string value is an ordinary URL, not code).
      const actionAttrs = ['action', 'formAction'].filter((n) => {
        const a = jsxAttr(lvl.opening!, n);
        return a?.initializer && ts.isJsxExpression(a.initializer) && !!a.initializer.expression;
      });
      const staticNames = [...jsxEventAttrs(lvl.opening).map((a) => a.name.getText()), ...actionAttrs];
      const runtimeNames = lvl.entry.runtimeHandlers;
      const names = new Set([...staticNames, ...(runtimeNames ?? [])]);
      for (const event of names) {
        if (i > 0 && !BUBBLING.has(event) && !((event === 'onSubmit' || event === 'action') && isSubmitControl)) continue;
        const runtimeAttached = runtimeNames ? runtimeNames.includes(event) : false;
        const info: { relation: Relation; hops: string[] } = this.resolveHandler(resolved, i, event);
        if (libraryComponent) {
          // What the library does with the function is not read; its name is the evidence.
          info.relation = {
            ...info.relation,
            evidence: info.relation.evidence === 'unresolved' ? 'unresolved' : 'inferred',
            note: [`passed to ${lvl.level.definition!.detail}'s <${lvl.entry.name}> as ${event}; TraceNaut assumes the library calls it ${event === 'onSubmit' ? 'when the form is submitted' : `on “${event.replace(/^on/, '').toLowerCase()}”`}, as the name says`, info.relation.note].filter(Boolean).join('; '),
          };
        }
        handlers.push({
          event,
          attachedAt: lvl.level.source!,
          attachedTo: `<${lvl.entry.name}>`,
          via: i === 0 ? undefined : event === 'onSubmit' ? 'form submission triggered by this control' : 'event bubbling from the clicked element',
          runtimeAttached,
          relation: info.relation,
          hops: info.hops,
        });
      }
    }
    if (req.adapter === 'dom') {
      notes.push('Framework internals were not readable, so handlers come from static JSX only and runtime attachment could not be checked.');
    }
    if (handlers.length === 0) notes.push('No event handlers are attached to this element or the ancestors an interaction would reach.');
    return { element: req.element, levels, primary, handlers, notes };
  }

  private resolveLevel(entry: InspectRequest['chain'][number]) {
    const level: InspectedLevel = { entry };
    const out: { entry: typeof entry; level: InspectedLevel; opening?: JsxOpening; ownerFn?: FnLike; definitionFn?: FnLike; project?: ServiceProject } = { entry, level };
    try {
      const { file, line, col } = parseLoc(entry.loc);
      const { project, sf } = this.sourceOf(file);
      const opening = jsxAt(sf, posOf(sf, line, col));
      if (!opening) throw new Error('JSX element not found at this location (the file may have changed since the page loaded)');
      level.source = this.ref(sf, jsxElementOf(opening));
      level.tag = jsxTagName(opening);
      const ownerFn = enclosingComponent(opening) ?? enclosingFn(opening);
      if (ownerFn) level.owner = this.fnNode(ownerFn);
      if (entry.type === 'component') {
        const t = this.resolveExpr(project, opening.tagName as ts.Expression);
        level.definition = t.node;
        out.definitionFn = t.fn;
      }
      Object.assign(out, { opening, ownerFn, project });
    } catch (err) {
      level.error = (err as Error).message;
    }
    return out;
  }

  /**
   * Follow a handler from the JSX it is attached to back to its definition, walking
   * through props and `{...spread}` using the *observed* component chain.
   */
  private resolveHandler(levels: ReturnType<Analyzer['resolveLevel']>[], start: number, event: string) {
    const hops: string[] = [];
    let i = start;
    let propName = event;
    for (let guard = 0; guard < 12; guard++) {
      const lvl = levels[i];
      if (!lvl?.opening || !lvl.project) break;
      const sf = lvl.opening.getSourceFile();
      const attr = jsxAttr(lvl.opening, propName);
      let t: Target | undefined;
      if (attr?.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
        t = this.resolveExpr(lvl.project, attr.initializer.expression);
        if (!t.prop) return { relation: { kind: 'handles' as const, evidence: t.evidence, target: t.node, note: t.note, site: this.ref(sf, attr) }, hops };
        propName = t.prop.name;
      } else if (!jsxHasSpread(lvl.opening)) {
        return {
          relation: {
            kind: 'handles' as const,
            evidence: 'unresolved' as const,
            target: this.unresolvedNode(sf, lvl.opening, event),
            note: 'attached at runtime, but not visible in this JSX (it may be added by library code)',
          },
          hops,
        };
      }
      // The value arrives through a prop (explicit or via spread): continue at the usage
      // site of the component that rendered this JSX, as observed in the chain.
      const owner = lvl.ownerFn;
      const useIdx = levels.findIndex((l, j) => j > i && l.entry.type === 'component' && l.definitionFn === owner);
      if (useIdx < 0 || !owner) break;
      const use = levels[useIdx];
      hops.push(`${attr ? `prop \`${propName}\`` : `{...spread} (${propName})`} ← <${fnName(owner)}> at ${use.level.source?.file}:${use.level.source?.line}`);
      i = useIdx;
    }
    const lvl = levels[start];
    const sf = lvl.opening!.getSourceFile();
    return {
      relation: {
        kind: 'handles' as const,
        evidence: 'unresolved' as const,
        target: this.unresolvedNode(sf, lvl.opening!, event),
        note: 'passed down through props from a component TraceNaut could not observe in the chain',
      },
      hops,
    };
  }

  /** Map a runtime probe (file, line, col, name) to its static node, when it still exists. */
  probeNode(file: string, line: number, col: number, name: string, kind: string): GraphNode {
    try {
      const { sf } = this.sourceOf(file);
      const fn = findFnAt(sf, posOf(sf, line, col), name);
      if (fn) return this.fnNode(fn);
    } catch {
      // fall through: the file is outside the configured services
    }
    return {
      id: located('fn', file, line, col),
      kind: kind === 'c' ? 'component' : kind === 'h' ? 'hook' : 'function',
      label: name,
      source: { service: serviceForFile(this.ws, file)?.name ?? '?', file, line, col },
      expandable: false,
    };
  }

  private async view(sf: ts.SourceFile, opts: Parameters<typeof codeView>[0]) {
    const v = await codeView(opts);
    v.syntax = syntaxSpans(sf, v.startLine, v.startLine + v.lines.length - 1);
    return v;
  }

  async sqlTokens(sql: string) {
    return highlightSnippet(sql, 'sql');
  }
}

// ---------------------------------------------------------------------------
// helpers

function callChain(call: ts.CallExpression): { root: string; calls: { name: string; args: readonly ts.Expression[] }[] } | undefined {
  const calls: { name: string; args: readonly ts.Expression[] }[] = [];
  let cur: ts.Expression = call;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    calls.unshift({ name: cur.expression.name.text, args: cur.arguments });
    cur = cur.expression.expression;
  }
  return ts.isIdentifier(cur) && calls.length ? { root: cur.text, calls } : undefined;
}

function literalNumbers(e: ts.Expression | undefined): (number | '?')[] {
  if (!e) return ['?'];
  if (ts.isNumericLiteral(e)) return [Number(e.text)];
  if (ts.isConditionalExpression(e)) return [...literalNumbers(e.whenTrue), ...literalNumbers(e.whenFalse)];
  if (ts.isParenthesizedExpression(e)) return literalNumbers(e.expression);
  return ['?'];
}

/** Nearest enclosing function with a real name (skips inline callbacks such as useMemo(() => …)). */
function namedEnclosingFn(node: ts.Node): FnLike | undefined {
  let fn = enclosingFn(node);
  while (fn && fnName(fn).includes(' ')) {
    const outer = enclosingFn(fn);
    if (!outer) break;
    fn = outer;
  }
  return fn;
}

type Outcome = { status: number | '?'; sends?: string[]; from?: string };

function keysOfBody(a: ts.Expression | undefined): string[] | undefined {
  if (!a) return undefined;
  while (ts.isParenthesizedExpression(a) || ts.isAsExpression(a)) a = a.expression;
  if (/^(null|undefined)$/.test(a.getText())) return undefined;
  return ts.isObjectLiteralExpression(a) ? a.properties.map((p) => p.name?.getText() ?? '…') : [a.getText().slice(0, 30)];
}

function statusIn(opts: ts.Expression | undefined): (number | '?')[] {
  if (!opts) return [];
  if (ts.isObjectLiteralExpression(opts)) {
    const p = opts.properties.find((x) => x.name?.getText() === 'status');
    return p && ts.isPropertyAssignment(p) ? literalNumbers(p.initializer) : [];
  }
  return literalNumbers(opts);
}

/**
 * Answers from handlers that return or send a response object rather than calling
 * Express's `res.json()`: `Response.json(x, { status })`, `new Response(…)`, `NextResponse.*`
 * (Next.js), `c.json(x, 404)` (Hono), `reply.code(401).send(x)` / a returned object
 * (Fastify), `ctx.status = 404; ctx.body = …` (Koa). A returned call to a project helper
 * (`return unauthorized()`) is followed one level.
 */
function fetchStyleOutcomes(project: ServiceProject, fn: FnLike, framework: string, depth = 0): Outcome[] {
  const checker = project.checker();
  const out: Outcome[] = [];
  const ctx = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : undefined;
  const reply = fn.parameters[1] && ts.isIdentifier(fn.parameters[1].name) ? fn.parameters[1].name.text : undefined;
  const fromResponseExpr = (e: ts.Expression): Outcome[] | undefined => {
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isNewExpression(e) && /^(Next)?Response$/.test(e.expression.getText())) {
      const st = statusIn(e.arguments?.[1]);
      return (st.length ? st : [200 as const]).map((status) => ({ status, sends: keysOfBody(e.arguments?.[0]) }));
    }
    if (!ts.isCallExpression(e)) return undefined;
    const callee = e.expression.getText();
    if (/^(Next)?Response\.json$/.test(callee)) {
      const st = statusIn(e.arguments[1]);
      return (st.length ? st : [200 as const]).map((status) => ({ status, sends: keysOfBody(e.arguments[0]) ?? [] }));
    }
    if (/^(Next)?Response\.redirect$/.test(callee)) return [{ status: (e.arguments[1] && literalNumbers(e.arguments[1])[0]) || (callee.startsWith('Next') ? 307 : 302) }];
    if (framework === 'hono' && ctx && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText() === ctx) {
      const m = e.expression.name.text;
      if (m === 'json' || m === 'text' || m === 'html' || m === 'body') {
        const st = e.arguments[1] ? literalNumbers(e.arguments[1]) : [];
        return (st.length ? st : [200 as const]).map((status) => ({ status, sends: m === 'json' ? (keysOfBody(e.arguments[0]) ?? []) : keysOfBody(e.arguments[0]) }));
      }
      if (m === 'redirect') return [{ status: (e.arguments[1] && literalNumbers(e.arguments[1])[0]) || 302 }];
    }
    // A project helper such as `unauthorized()` or `json(data)` that builds the response.
    if (depth === 0) {
      const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
      const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const decl = target?.valueDeclaration;
      const helper = decl && (isFnLike(decl) ? decl : ts.isVariableDeclaration(decl) && decl.initializer && isFnLike(decl.initializer) ? decl.initializer : undefined);
      if (helper && !isExternalFile(helper.getSourceFile().fileName)) {
        const inner = fetchStyleOutcomes(project, helper, framework, 1);
        if (inner.length) return inner.map((o) => ({ ...o, from: fnName(helper) }));
      }
    }
    return undefined;
  };
  let koaStatus: (number | '?')[] = [];
  let koaBody: string[] | undefined;
  const visit = (n: ts.Node) => {
    if (n !== fn && isFnLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const got = fromResponseExpr(n.expression);
      if (got) out.push(...got);
      else if (framework === 'fastify' && ts.isObjectLiteralExpression(n.expression)) out.push({ status: 200, sends: keysOfBody(n.expression) });
    }
    if (ts.isArrowFunction(fn) && n === fn.body && !ts.isBlock(fn.body)) {
      const got = fromResponseExpr(fn.body as ts.Expression);
      if (got) out.push(...got);
      else if (framework === 'fastify' && ts.isParenthesizedExpression(fn.body) && ts.isObjectLiteralExpression(fn.body.expression)) out.push({ status: 200, sends: keysOfBody(fn.body.expression) });
    }
    // Fastify: `reply.code(401).send({ error })`.
    if (framework === 'fastify' && reply && ts.isCallExpression(n) && !(ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent))) {
      const chain = callChain(n);
      if (chain && chain.root === reply && chain.calls.some((c) => c.name === 'send')) {
        const code = chain.calls.find((c) => c.name === 'code' || c.name === 'status');
        const st = code ? literalNumbers(code.args[0]) : [];
        const send = chain.calls.find((c) => c.name === 'send');
        for (const status of st.length ? st : [200 as const]) out.push({ status, sends: keysOfBody(send?.args[0]) });
      }
    }
    // Koa: `ctx.status = 404; ctx.body = { … }`.
    if (framework === 'koa-router' && ctx && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.getText() === ctx) {
      if (n.left.name.text === 'status') koaStatus = [...koaStatus, ...literalNumbers(n.right)];
      if (n.left.name.text === 'body') koaBody = keysOfBody(n.right) ?? [];
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  if (framework === 'koa-router' && (koaBody || koaStatus.length)) for (const status of koaStatus.length ? koaStatus : [200 as const]) out.push({ status, sends: koaBody });
  return out;
}

function requestNote(req: ResolvedRequest, how: string) {
  if (req.shape === 'literal') return `URL and method resolved ${how}`;
  if (req.shape === 'parametric') return `resolved ${how}; {segments} are filled in at runtime`;
  if (req.shape === 'prefixed') return `path resolved ${how}; ${req.assumedBase} adds a base address known only at runtime`;
  return `only partly resolvable ${how}: part of the URL or the method depends on runtime values`;
}

function typeOwnerName(decl: ts.PropertySignature | ts.MethodSignature) {
  const parent = decl.parent;
  if (ts.isInterfaceDeclaration(parent)) return parent.name.text;
  if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) return parent.parent.name.text;
  return 'an object type';
}

function componentNameNode(fn: FnLike): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name;
  if (ts.isMethodDeclaration(fn)) return fn.name;
  const p = fn.parent;
  if (ts.isVariableDeclaration(p)) return p.name;
  if (ts.isCallExpression(p) && ts.isVariableDeclaration(p.parent)) return p.parent.name;
  if (ts.isPropertyAssignment(p)) return p.name;
  return undefined;
}

function findNodeAtSpan(sf: ts.SourceFile, start: number): ts.Node | undefined {
  let best: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (start < n.getStart(sf) || start >= n.getEnd()) return;
    best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

function findInnermostCall(sf: ts.SourceFile, pos: number) {
  let best: ts.CallExpression | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos > n.getEnd()) return;
    if (ts.isCallExpression(n) && n.getStart(sf) === pos) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

function findInnermostLiteral(sf: ts.SourceFile, pos: number) {
  let best: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos > n.getEnd()) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && n.getStart(sf) === pos) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

function findInnermostClass(sf: ts.SourceFile, pos: number) {
  let best: ts.ClassDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos > n.getEnd()) return;
    if (ts.isClassDeclaration(n)) best = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

/** Clickable call sites in a code view; function targets win over request targets at the same range. */
function marksFor(relations: Relation[], file: string): CodeMark[] {
  const byRange = new Map<string, CodeMark & { rank: number }>();
  for (const r of relations) {
    const s = r.site;
    if (!s || s.file !== file || s.col === undefined || s.endCol === undefined || !r.target.expandable) continue;
    const key = `${s.line}:${s.col}`;
    const rank = r.kind === 'requests' || r.kind === 'queries' ? 1 : 0;
    const prev = byRange.get(key);
    if (prev && prev.rank <= rank) continue;
    byRange.set(key, { line: s.line, col: s.col, endCol: s.endCol, nodeId: r.target.id, evidence: r.evidence, rank });
  }
  return [...byRange.values()].map(({ rank, ...m }) => m);
}

function describeKind(kind: string) {
  return { component: 'React component', hook: 'React hook', method: 'Method', function: 'Function' }[kind] ?? kind;
}

/** A call that changes the page: Next.js router, React Router's navigate, window.location. */
function navigationOf(call: ts.CallExpression, checker: ts.TypeChecker): { router: string; method: string; to?: string } | undefined {
  const callee = call.expression;
  const target = call.arguments[0] ? navTarget(call.arguments[0]) : undefined;
  const typeName = (e: ts.Expression) => checker.typeToString(checker.getTypeAtLocation(e));
  // Names first (cheap); types only for calls that could be navigation.
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (!/^(push|replace|back|forward|refresh|assign)$/.test(method)) return undefined;
    const owner = typeName(callee.expression);
    if (/^(push|replace|back|forward|refresh)$/.test(method) && /\b(AppRouterInstance|NextRouter)\b/.test(owner)) return { router: 'Next.js router', method, to: target };
    if (/^(assign|replace)$/.test(method) && /^(window\.)?location$/.test(callee.expression.getText())) return { router: 'browser location', method, to: target };
    return undefined;
  }
  if (ts.isIdentifier(callee)) {
    const sym = checker.getSymbolAtLocation(callee);
    const decl = sym?.valueDeclaration;
    // const navigate = useNavigate() (React Router)
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer) && /useNavigate$/.test(decl.initializer.expression.getText())) {
      if (/\bNavigateFunction\b/.test(typeName(callee))) return { router: 'React Router', method: 'navigate', to: target };
    }
    // const { push, replace } = useRouter() (Next.js): the destructured methods keep their type.
    if (decl && ts.isBindingElement(decl) && ts.isVariableDeclaration(decl.parent.parent) && decl.parent.parent.initializer) {
      const method = (decl.propertyName ?? decl.name).getText();
      if (/^(push|replace|back|forward|refresh)$/.test(method) && /\b(AppRouterInstance|NextRouter)\b/.test(typeName(decl.parent.parent.initializer))) return { router: 'Next.js router', method, to: target };
    }
  }
  return undefined;
}

function navTarget(e: ts.Expression): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `{${s.expression.getText().slice(0, 20)}}${s.literal.text}`).join('');
  return `{${e.getText().slice(0, 30)}}`;
}

function isSubmit(el: InspectRequest['element']) {
  const type = (el.attributes.type ?? '').toLowerCase();
  if (el.tag === 'button') return type === '' || type === 'submit';
  return el.tag === 'input' && (type === 'submit' || type === 'image');
}

export function sqlLabel(sql: string) {
  const text = sql.trim().replace(/\s+/g, ' ');
  const op = text.split(' ')[0].toUpperCase();
  const tables = sqlTables(text);
  return tables.length ? `${op} ${tables.join(', ')}` : text.slice(0, 48);
}

export function sqlTables(sql: string) {
  const out = new Set<string>();
  // Optionally schema-qualified and quoted: users, public.users, "public"."users".
  const re = /\b(?:from|into|update|join|table(?:\s+if\s+not\s+exists)?)\s+(?:["`]?[A-Za-z_]\w*["`]?\.)?["`]?([A-Za-z_]\w*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.add(m[1]);
  return [...out];
}
