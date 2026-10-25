import ts from 'typescript';
import type { SyntaxSpan } from '@tracenaut/protocol';
import { isJsxOpening, isHostTag } from './ast.js';

/**
 * Notation worth explaining to someone new to the language, found from the syntax
 * tree (not from text patterns). Each span points at a concept in the client's
 * concept library. Only single-line ranges are emitted.
 */

const HOOK_CONCEPTS: Record<string, string> = {
  useState: 'use-state',
  useEffect: 'use-effect',
  useCallback: 'use-callback',
  useMemo: 'use-memo',
  useContext: 'use-context',
  createContext: 'context',
};
const SQL_HINT = /^\s*(select|insert|update|delete|create|with)\b/i;

export function syntaxSpans(sf: ts.SourceFile, fromLine: number, toLine: number): SyntaxSpan[] {
  const out: SyntaxSpan[] = [];
  const startPos = sf.getPositionOfLineAndCharacter(Math.max(0, fromLine - 1), 0);
  const lineStarts = sf.getLineStarts();
  const endPos = toLine >= lineStarts.length ? sf.text.length : lineStarts[toLine];

  const add = (start: number, end: number, concept: string) => {
    if (start < startPos || end > endPos || end <= start) return;
    const a = sf.getLineAndCharacterOfPosition(start);
    const b = sf.getLineAndCharacterOfPosition(end);
    if (a.line !== b.line) return;
    out.push({ line: a.line + 1, col: a.character, endCol: b.character, concept });
  };
  const addNode = (n: ts.Node, concept: string) => add(n.getStart(sf), n.getEnd(), concept);
  const addToken = (n: ts.Node, kind: ts.SyntaxKind, concept: string) => {
    const tok = n.getChildren(sf).find((c) => c.kind === kind);
    if (tok) addNode(tok, concept);
  };
  const addKeyword = (n: ts.Node, length: number, concept: string) => add(n.getStart(sf), n.getStart(sf) + length, concept);

  const visit = (n: ts.Node) => {
    if (n.getEnd() < startPos || n.getStart(sf) > endPos) return;

    if (ts.canHaveModifiers(n)) {
      for (const m of ts.getModifiers(n) ?? []) {
        if (m.kind === ts.SyntaxKind.AsyncKeyword) addNode(m, 'async-await');
        if (m.kind === ts.SyntaxKind.ExportKeyword) addNode(m, 'import-export');
      }
    }
    if (isJsxOpening(n)) {
      addNode(n.tagName, isHostTag(n.tagName.getText(sf)) ? 'jsx' : 'component-usage');
    } else if (ts.isJsxSpreadAttribute(n)) {
      add(n.getStart(sf) + 1, n.getStart(sf) + 4, 'spread');
    } else if (ts.isJsxExpression(n) && n.expression && ts.isJsxAttribute(n.parent)) {
      add(n.getStart(sf), n.getStart(sf) + 1, 'jsx-expression');
    } else if (ts.isAwaitExpression(n)) {
      addKeyword(n, 5, 'async-await');
    } else if (ts.isArrowFunction(n)) {
      addNode(n.equalsGreaterThanToken, 'arrow-function');
    } else if (ts.isFunctionDeclaration(n)) {
      addToken(n, ts.SyntaxKind.FunctionKeyword, 'function');
    } else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) {
      addNode(n, 'destructuring');
    } else if (ts.isTemplateExpression(n)) {
      addNode(n.head, 'template-literal');
    } else if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) {
      addKeyword(n, 3, 'spread');
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      addNode(n.operatorToken, 'nullish');
    } else if (ts.isPropertyAccessExpression(n) && n.questionDotToken) {
      addNode(n.questionDotToken, 'optional-chaining');
    } else if (ts.isConditionalExpression(n)) {
      addNode(n.questionToken, 'ternary');
    } else if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && n.type) {
      addNode(n.type, 'type-annotation');
    } else if (ts.isTypeAliasDeclaration(n)) {
      addToken(n, ts.SyntaxKind.TypeKeyword, 'type-alias');
    } else if (ts.isInterfaceDeclaration(n)) {
      addToken(n, ts.SyntaxKind.InterfaceKeyword, 'type-alias');
    } else if (ts.isImportDeclaration(n)) {
      addKeyword(n, 6, 'import-export');
    } else if (ts.isTryStatement(n)) {
      addKeyword(n, 3, 'try-catch');
    } else if (ts.isThrowStatement(n)) {
      addKeyword(n, 5, 'throw');
    } else if (ts.isNewExpression(n)) {
      addKeyword(n, 3, 'new');
    } else if (ts.isVariableDeclarationList(n)) {
      const kw = n.flags & ts.NodeFlags.Const ? 5 : n.flags & ts.NodeFlags.Let ? 3 : 3;
      addKeyword(n, kw, 'variable');
    } else if (ts.isCallExpression(n)) {
      if (n.typeArguments?.length) add(n.typeArguments.pos - 1, n.typeArguments.end + 1, 'generics');
      if (ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        if (HOOK_CONCEPTS[name]) addNode(n.expression, HOOK_CONCEPTS[name]);
        else if (/^use[A-Z]/.test(name)) addNode(n.expression, 'hook');
      }
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && SQL_HINT.test(n.text)) {
      // `?` placeholders inside SQL text.
      const start = n.getStart(sf) + 1;
      for (let i = 0; i < n.text.length; i++) if (n.text[i] === '?') add(start + i, start + i + 1, 'sql-placeholder');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
