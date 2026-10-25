/**
 * TraceNaut source instrumentation.
 *
 * Two independent, opt-in transforms that run on the *original* source (before any
 * other compiler step) so every location they record refers to the file on disk:
 *
 *  1. JSX locations — each host element gets `data-tn-loc="file:line:col"`, each
 *     component usage gets `data-tn-use="file:line:col"`. The browser client reads
 *     these from the DOM / React fibers to map a clicked element back to the exact
 *     JSX that produced it. This is runtime evidence: the element on screen was
 *     rendered by that JSX node.
 *
 *  2. Function probes — every function body is wrapped so that, *only while a trace
 *     is armed*, entering and leaving it is recorded. When no trace is armed the
 *     probe is a single boolean check. Awaits are bracketed so async call stacks
 *     stay correct across suspension points.
 */
import type { NodePath, PluginObj, types as BabelTypes } from '@babel/core';

export interface InstrumentOptions {
  /** Repo-relative path of the file being transformed; used verbatim in ids. */
  file: string;
  jsxLocations?: boolean;
  probes?: boolean;
}

import { RUNTIME_GLOBAL } from './runtime.js';

export { RUNTIME_GLOBAL };
const RT = '__tn$';
const TOKEN = '__tn$t';

/** Probe ids are `file|line|col|kind|name`; kind: f = function, c = component, h = hook. */
export type ProbeKind = 'f' | 'c' | 'h';

export function parseProbeId(id: string) {
  const [file, line, col, kind, ...rest] = id.split('|');
  return { file, line: Number(line), col: Number(col), kind: kind as ProbeKind, name: rest.join('|') };
}

export default function tracenautInstrument(
  { types: t }: { types: typeof BabelTypes },
  opts: InstrumentOptions,
): PluginObj {
  const handled = new WeakSet<BabelTypes.Node>();

  function locString(node: BabelTypes.Node) {
    const start = node.loc!.start;
    return `${opts.file}:${start.line}:${start.column}`;
  }

  function jsxName(name: BabelTypes.JSXOpeningElement['name']): string {
    if (t.isJSXIdentifier(name)) return name.name;
    if (t.isJSXMemberExpression(name)) return `${jsxName(name.object)}.${name.property.name}`;
    return `${name.namespace.name}:${name.name.name}`;
  }

  function isHostTag(name: string) {
    return /^[a-z]/.test(name) || name.includes('-') || name.includes(':');
  }

  function hasAttr(node: BabelTypes.JSXOpeningElement, attr: string) {
    return node.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attr);
  }

  function inferName(path: NodePath<BabelTypes.Function>): string {
    const node = path.node;
    if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) return node.id.name;
    if (t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassPrivateMethod(node)) {
      const key = node.key;
      if (t.isIdentifier(key)) return key.name;
      if (t.isStringLiteral(key)) return key.value;
      if (t.isPrivateName(key)) return `#${key.id.name}`;
      return '<computed>';
    }
    const parent = path.parentPath;
    if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
    if (parent.isAssignmentExpression()) {
      const left = parent.node.left;
      if (t.isIdentifier(left)) return left.name;
      if (t.isMemberExpression(left) && t.isIdentifier(left.property)) return left.property.name;
    }
    if (parent.isObjectProperty() && t.isIdentifier(parent.node.key)) return parent.node.key.name;
    if (parent.isClassProperty() && t.isIdentifier(parent.node.key)) return parent.node.key.name;
    if (parent.isJSXExpressionContainer() && parent.parentPath.isJSXAttribute()) {
      const attr = parent.parentPath.node.name;
      return `${t.isJSXIdentifier(attr) ? attr.name : 'attr'} handler`;
    }
    if (parent.isCallExpression()) {
      const callee = parent.node.callee;
      // useCallback returns the function itself, so it takes the variable's name.
      if (t.isIdentifier(callee) && callee.name === 'useCallback') {
        const decl = parent.parentPath;
        if (decl.isVariableDeclarator() && t.isIdentifier(decl.node.id)) return decl.node.id.name;
      }
      const calleeName = t.isIdentifier(callee)
        ? callee.name
        : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
          ? callee.property.name
          : 'call';
      const first = parent.node.arguments[0];
      const routeArg = t.isStringLiteral(first) ? `('${first.value}')` : '';
      return `${calleeName}${routeArg} callback`;
    }
    if (parent.isExportDefaultDeclaration()) return 'default';
    return '<anonymous>';
  }

  function containsJsx(path: NodePath<BabelTypes.Function>) {
    let found = false;
    path.traverse({
      JSXElement(p) {
        found = true;
        p.stop();
      },
      JSXFragment(p) {
        found = true;
        p.stop();
      },
    });
    return found;
  }

  function probeKind(name: string, path: NodePath<BabelTypes.Function>): ProbeKind {
    if (name.includes(' ')) return 'f';
    if (/^use[A-Z0-9]/.test(name)) return 'h';
    if (/^[A-Z]/.test(name) && containsJsx(path)) return 'c';
    return 'f';
  }

  const rt = (method: string, ...args: BabelTypes.Expression[]) =>
    t.callExpression(t.memberExpression(t.identifier(RT), t.identifier(method)), args);

  return {
    name: 'tracenaut-instrument',
    visitor: {
      Program(path) {
        if (!opts.probes) return;
        // const __tn$ = globalThis.__TRACENAUT__ ?? <no-op stub>;
        const stub = t.objectExpression([
          t.objectProperty(t.identifier('e'), t.arrowFunctionExpression([], t.numericLiteral(0))),
          t.objectProperty(t.identifier('x'), t.arrowFunctionExpression([], t.identifier('undefined'))),
          t.objectProperty(t.identifier('k'), t.arrowFunctionExpression([], t.identifier('undefined'))),
          t.objectProperty(
            t.identifier('s'),
            t.arrowFunctionExpression([t.identifier('_'), t.identifier('v')], t.identifier('v')),
          ),
          t.objectProperty(
            t.identifier('r'),
            t.arrowFunctionExpression([t.identifier('_'), t.identifier('v')], t.identifier('v')),
          ),
        ]);
        const decl = t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(RT),
            t.logicalExpression(
              '??',
              t.memberExpression(t.identifier('globalThis'), t.identifier(RUNTIME_GLOBAL)),
              stub,
            ),
          ),
        ]);
        path.unshiftContainer('body', decl);
      },

      JSXOpeningElement(path) {
        if (!opts.jsxLocations || !path.node.loc) return;
        const name = jsxName(path.node.name);
        if (name === 'Fragment' || name.endsWith('.Fragment')) return;
        const attr = isHostTag(name) ? 'data-tn-loc' : 'data-tn-use';
        if (hasAttr(path.node, attr)) return;
        // Appended last so a spread of forwarded props can never overwrite it.
        path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier(attr), t.stringLiteral(locString(path.node))));
      },

      Function(path) {
        if (!opts.probes) return;
        const node = path.node;
        if (handled.has(node) || !node.loc || node.generator) return;
        if (t.isClassMethod(node) && node.kind === 'constructor') return;
        if (t.isTSDeclareMethod?.(node)) return;
        handled.add(node);

        const name = inferName(path).replace(/\|/g, '/');
        const start = node.loc.start;
        const id = `${opts.file}|${start.line}|${start.column}|${probeKind(name, path)}|${name}`;

        if (node.async) {
          path.traverse({
            Function(inner) {
              inner.skip();
            },
            AwaitExpression(awaitPath) {
              if (handled.has(awaitPath.node)) return;
              const bracketed = t.awaitExpression(rt('s', t.identifier(TOKEN), awaitPath.node.argument));
              handled.add(bracketed);
              awaitPath.replaceWith(rt('r', t.identifier(TOKEN), bracketed));
            },
            // After a rejected await, `r` never runs: re-establish the frame in catch/finally.
            CatchClause(catchPath) {
              catchPath.node.body.body.unshift(t.expressionStatement(rt('k', t.identifier(TOKEN))));
            },
            TryStatement(tryPath) {
              tryPath.node.finalizer?.body.unshift(t.expressionStatement(rt('k', t.identifier(TOKEN))));
            },
          });
        }

        const originalBody = t.isBlockStatement(node.body) ? node.body : t.blockStatement([t.returnStatement(node.body)]);
        const directives = originalBody.directives;
        originalBody.directives = [];
        const wrapped = t.blockStatement(
          [
            t.variableDeclaration('const', [t.variableDeclarator(t.identifier(TOKEN), rt('e', t.stringLiteral(id)))]),
            t.tryStatement(
              originalBody,
              null,
              t.blockStatement([t.expressionStatement(rt('x', t.identifier(TOKEN)))]),
            ),
          ],
          directives,
        );
        node.body = wrapped;
      },
    },
  };
}
