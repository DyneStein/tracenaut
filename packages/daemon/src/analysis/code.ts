import { createHighlighter, type Highlighter } from 'shiki';
import { readFileSync, statSync } from 'node:fs';
import type { CodeMark, CodeView, Token } from '@tracenaut/protocol';

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;
const MAX_VIEW_LINES = 160;

let highlighter: Promise<Highlighter> | undefined;
const cache = new Map<string, { mtime: number; lines: Token[][] }>();

function getHighlighter() {
  highlighter ??= createHighlighter({
    themes: [THEMES.light, THEMES.dark],
    langs: ['tsx', 'typescript', 'jsx', 'javascript', 'sql', 'json'],
  });
  return highlighter;
}

export function languageOf(file: string) {
  if (file.endsWith('.tsx')) return 'tsx';
  if (/\.(m|c)?ts$/.test(file)) return 'typescript';
  if (file.endsWith('.jsx')) return 'jsx';
  if (file.endsWith('.json')) return 'json';
  if (file.endsWith('.sql')) return 'sql';
  return 'javascript';
}

async function tokenizeFile(absPath: string): Promise<Token[][]> {
  const mtime = statSync(absPath).mtimeMs;
  const hit = cache.get(absPath);
  if (hit && hit.mtime === mtime) return hit.lines;
  const hl = await getHighlighter();
  const code = readFileSync(absPath, 'utf8');
  const result = hl.codeToTokens(code, { lang: languageOf(absPath) as 'tsx', themes: THEMES });
  const lines = result.tokens.map((line) =>
    line.map((tok) => {
      const style = (tok.htmlStyle ?? {}) as Record<string, string>;
      return {
        text: tok.content,
        color: style.color ?? tok.color,
        darkColor: style['--shiki-dark'],
        fontStyle: tok.fontStyle || undefined,
      } satisfies Token;
    }),
  );
  cache.set(absPath, { mtime, lines });
  return lines;
}

export async function codeView(opts: {
  service: string;
  file: string;
  absPath: string;
  from: number;
  to: number;
  focus?: { from: number; to: number };
  marks?: CodeMark[];
}): Promise<CodeView> {
  const all = await tokenizeFile(opts.absPath);
  const from = Math.max(1, opts.from);
  let to = Math.min(all.length, opts.to);
  let truncated = false;
  if (to - from + 1 > MAX_VIEW_LINES) {
    to = from + MAX_VIEW_LINES - 1;
    truncated = true;
  }
  return {
    service: opts.service,
    file: opts.file,
    absPath: opts.absPath,
    language: languageOf(opts.file),
    startLine: from,
    lines: all.slice(from - 1, to),
    focus: opts.focus,
    marks: (opts.marks ?? []).filter((m) => m.line >= from && m.line <= to),
    truncated,
  };
}

/** Highlight a standalone snippet (e.g. a SQL statement). */
export async function highlightSnippet(code: string, lang: string): Promise<Token[][]> {
  const hl = await getHighlighter();
  return hl.codeToTokens(code, { lang: lang as 'sql', themes: THEMES }).tokens.map((line) =>
    line.map((tok) => {
      const style = (tok.htmlStyle ?? {}) as Record<string, string>;
      return { text: tok.content, color: style.color ?? tok.color, darkColor: style['--shiki-dark'] };
    }),
  );
}
