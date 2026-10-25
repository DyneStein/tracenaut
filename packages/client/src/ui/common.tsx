import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { CodeView as CodeViewData, Evidence, GraphNode, NodeKind, Relation, SourceRef, Token } from '@tracenaut/protocol';
import { api } from '../api.js';
import { useExplain } from '../learn/explain.js';

// ---------------------------------------------------------------- navigation

export type View =
  | { kind: 'home' }
  | { kind: 'element'; key: number }
  | { kind: 'node'; id: string }
  | { kind: 'trace'; key: number };

export interface Nav {
  open(view: View): void;
  editor: string;
}

export const NavContext = createContext<Nav>({ open: () => {}, editor: 'vscode' });
export const useNav = () => useContext(NavContext);

// ---------------------------------------------------------------- data hook

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; canRetry?: boolean; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (err) => live && setState({ error: String(err?.message ?? err), canRetry: err?.retry !== false, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** A failure shown in the panel, with "Try again" when trying again can help. */
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="error" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button class="soft-btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- icons

type IconProps = { size?: number };
const svg = (path: preact.ComponentChildren, { size = 14 }: IconProps = {}) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {path}
  </svg>
);
export const Icon = {
  logo: (p?: IconProps) => svg(<><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" /><circle cx="8" cy="8" r="1" fill="currentColor" /></>, p),
  back: (p?: IconProps) => svg(<path d="M10 3.5 5.5 8l4.5 4.5" />, p),
  fwd: (p?: IconProps) => svg(<path d="M6 3.5 10.5 8 6 12.5" />, p),
  close: (p?: IconProps) => svg(<path d="M4 4l8 8M12 4l-8 8" />, p),
  chev: (p?: IconProps) => svg(<path d="M6 4l4 4-4 4" />, p),
  pick: (p?: IconProps) => svg(<><path d="M3 3l4.2 10 1.5-4.3L13 7.2z" /></>, p),
  rec: (p?: IconProps) => svg(<><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.2" fill="currentColor" /></>, p),
  open: (p?: IconProps) => svg(<><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" /></>, p),
  info: (p?: IconProps) => svg(<><circle cx="8" cy="8" r="6" /><path d="M8 7.2v3.6M8 5.1v.1" /></>, p),
  play: (p?: IconProps) => svg(<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />, p),
  arrows: (p?: IconProps) => svg(<><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8" /><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13" /></>, p),
  code: (p?: IconProps) => svg(<path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" />, p),
};

const KIND_GLYPH: Record<NodeKind, string> = {
  element: '<>',
  component: '◇',
  function: 'ƒ',
  hook: 'h',
  method: 'm',
  class: 'C',
  'http-request': '⇄',
  'http-route': '→',
  sql: 'DB',
  'orm-query': 'DB',
  external: '□',
  state: 's',
  unresolved: '?',
};

export function KindIcon({ kind }: { kind: NodeKind }) {
  return (
    <span class={`kind-icon k-${kind}`} title={kind.replace('-', ' ')}>
      {KIND_GLYPH[kind]}
    </span>
  );
}

// ---------------------------------------------------------------- evidence

export const EVIDENCE_HELP: Record<Evidence, string> = {
  static: 'From source analysis: this relationship exists in the code. It may or may not execute.',
  runtime: 'Observed during an actual execution.',
  inferred: 'A heuristic link (e.g. URL pattern ↔ route). Plausible, not proven.',
  unresolved: 'TraceNaut could not determine this statically. See the note for why.',
};

export function Badge({ evidence }: { evidence: Evidence }) {
  return (
    <span class={`badge ${evidence}`} title={EVIDENCE_HELP[evidence]}>
      {evidence}
    </span>
  );
}

// ---------------------------------------------------------------- locations

export function shortFile(file: string) {
  return file.split('/').pop() ?? file;
}

export function Loc({ source, short = true }: { source?: SourceRef; short?: boolean }) {
  if (!source) return null;
  const text = `${short ? shortFile(source.file) : source.file}:${source.line}`;
  return (
    <span class="loc" title={`${source.file}:${source.line}`}>
      {text}
    </span>
  );
}

export function editorUrl(editor: string, absPath: string, line: number, col = 0) {
  const p = encodeURI(absPath);
  switch (editor) {
    case 'cursor':
      return `cursor://file${p}:${line}:${col + 1}`;
    case 'idea':
    case 'webstorm':
      return `${editor}://open?file=${p}&line=${line}`;
    case 'zed':
      return `zed://file${p}:${line}`;
    default:
      return `vscode://file${p}:${line}:${col + 1}`;
  }
}

// ---------------------------------------------------------------- code view

function tokenSpan(tok: Token, key: number) {
  const style = `--c:${tok.color ?? 'inherit'};${tok.darkColor ? `--cd:${tok.darkColor};` : ''}${tok.fontStyle === 1 ? 'font-style:italic;' : ''}`;
  return (
    <span key={key} class="tok" style={style}>
      {tok.text}
    </span>
  );
}

/**
 * Source code with clickable call sites and explainable notation. It never scrolls
 * vertically inside the panel (nested scroll areas trap the wheel): long code shows a
 * window around the relevant lines with a control to reveal the rest. `wrap` folds long
 * lines instead of scrolling sideways.
 */
export function CodeBlock({ code, wrap = false, windowLines = 16 }: { code: CodeViewData; wrap?: boolean; windowLines?: number }) {
  const nav = useNav();
  const ex = useExplain();
  const total = code.lines.length;
  const [showAll, setShowAll] = useState(total <= windowLines + 4);
  const firstFocus = code.focus?.from;
  const syntax = code.syntax ?? [];
  const focusIndex = firstFocus ? Math.max(0, firstFocus - code.startLine - 2) : 0;
  const from = showAll ? 0 : Math.min(focusIndex, Math.max(0, total - windowLines));
  const to = showAll ? total : Math.min(total, from + windowLines);
  return (
    <div class={`code${wrap ? ' wrap' : ''}`}>
      <div class="code-head">
        <span class="loc" title={code.file}>
          {code.file}
        </span>
        <a class="icon-btn" title="Open in your editor" href={editorUrl(nav.editor, code.absPath, firstFocus ?? code.startLine)}>
          {Icon.open()}
        </a>
      </div>
      <div class="code-scroll">
        <pre>
          {code.lines.slice(from, to).map((tokens, j) => {
            const i = from + j;
            const line = code.startLine + i;
            const focus = code.focus && line >= code.focus.from && line <= code.focus.to;
            const ranges: Range[] = [
              ...code.marks.filter((m) => m.line === line).map((m) => ({ col: m.col, endCol: m.endCol, mark: m })),
              ...syntax.filter((s) => s.line === line).map((s) => ({ col: s.col, endCol: s.endCol, concept: s.concept })),
            ];
            return (
              <div key={line} class={`line${focus ? ' focus' : ''}`}>
                <span class="ln">{line}</span>
                <span>{renderLine(tokens, ranges, (id) => nav.open({ kind: 'node', id }), ex)}</span>
              </div>
            );
          })}
        </pre>
      </div>
      {total > windowLines + 4 ? (
        <button class="code-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
          {showAll ? 'Show fewer lines' : `Show all ${total} lines`}
        </button>
      ) : null}
      {code.truncated ? <div class="code-note">Showing the first lines only. Open in your editor for the rest.</div> : null}
    </div>
  );
}

type Range = { col: number; endCol: number; mark?: CodeViewData['marks'][number]; concept?: string };

/**
 * Split tokens at range boundaries. Call sites (marks) become links to their definition;
 * syntax spans become explainable notation (hover for a definition, click to pin it).
 */
function renderLine(tokens: Token[], ranges: Range[], open: (id: string) => void, ex: ReturnType<typeof useExplain>) {
  if (ranges.length === 0) return tokens.map(tokenSpan);
  const cuts = new Set<number>();
  for (const r of ranges) {
    cuts.add(r.col);
    cuts.add(r.endCol);
  }
  type Piece = { tok: Token; mark?: Range['mark']; concept?: string };
  const pieces: Piece[] = [];
  let col = 0;
  for (const tok of tokens) {
    let start = col;
    let text = tok.text;
    while (text.length) {
      const next = Math.min(start + text.length, ...[...cuts].filter((c) => c > start));
      const len = next - start;
      const at = (r: Range) => start >= r.col && start < r.endCol;
      pieces.push({ tok: { ...tok, text: text.slice(0, len) }, mark: ranges.find((r) => r.mark && at(r))?.mark, concept: ranges.find((r) => r.concept && at(r))?.concept });
      text = text.slice(len);
      start += len;
    }
    col += tok.text.length;
  }
  // Group consecutive pieces that share the same link / explanation.
  const out: preact.ComponentChildren[] = [];
  let k = 0;
  for (let i = 0; i < pieces.length; ) {
    const { mark, concept } = pieces[i];
    let j = i;
    const group: preact.ComponentChildren[] = [];
    while (j < pieces.length && pieces[j].mark === mark && pieces[j].concept === concept) group.push(tokenSpan(pieces[j++].tok, k++));
    let node: preact.ComponentChildren = group;
    if (concept) {
      node = (
        <span
          key={`s${k++}`}
          class="syn"
          data-concept={concept}
          // mouseover (not mouseenter): it bubbles from the token spans inside, so it also fires
          // when the code re-renders under a pointer that has not left the notation.
          onMouseOver={(e) => ex.hover(concept, e.currentTarget as Element)}
          onMouseLeave={() => ex.leave()}
          onClick={(e) => {
            if (mark) return;
            e.stopPropagation();
            ex.pin(concept, e.currentTarget as Element);
          }}
        >
          {node}
        </span>
      );
    }
    if (mark) {
      node = (
        <span key={`m${k++}`} class={`mark ${mark.evidence}`} title="Go to definition" onClick={() => open(mark.nodeId)}>
          {node}
        </span>
      );
    }
    out.push(node);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- relation tree

const QUIET_KINDS = new Set<NodeKind>(['external', 'state']);

const RELATION_VERB: Record<Relation['kind'], string> = {
  handles: 'handler',
  calls: 'calls',
  constructs: 'new',
  renders: 'renders',
  requests: 'request',
  'routes-to': 'route',
  middleware: 'middleware',
  queries: 'SQL',
  'implemented-by': 'calls',
  navigates: 'goes to',
};

export function RelationList({ relations, depth = 0, seen = new Set<string>() }: { relations: Relation[]; depth?: number; seen?: Set<string> }) {
  const main = relations.filter((r) => !QUIET_KINDS.has(r.target.kind));
  const quiet = relations.filter((r) => QUIET_KINDS.has(r.target.kind));
  return (
    <ul class="tree">
      {main.map((r) => (
        <RelationRow key={`${r.kind}|${r.target.id}`} relation={r} depth={depth} seen={seen} />
      ))}
      {quiet.length ? (
        <li class="uses" title="Library calls and state updates are listed compactly so you can skip what you already know.">
          <span>uses</span>
          {quiet.map((r) => (
            <span class="chip" key={r.target.id} title={`${r.target.detail ?? ''}${r.note ? ` — ${r.note}` : ''}`}>
              {r.target.label}
              {r.sites && r.sites > 1 ? ` ×${r.sites}` : ''}
            </span>
          ))}
        </li>
      ) : null}
      {main.length === 0 && quiet.length === 0 && depth > 0 ? <li class="row-note">Nothing further that TraceNaut can see.</li> : null}
    </ul>
  );
}

function RelationRow({ relation: r, depth, seen }: { relation: Relation; depth: number; seen: Set<string> }) {
  const nav = useNav();
  const [open, setOpen] = useState(false);
  const cycle = seen.has(r.target.id);
  const canExpand = r.target.expandable && !cycle && depth < 12;
  return (
    <li>
      <div class="row">
        <button class={`chev${open ? ' open' : ''}${canExpand ? '' : ' none'}`} onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
          {Icon.chev({ size: 12 })}
        </button>
        <KindIcon kind={r.target.kind} />
        <button
          class="row-main"
          onClick={() => (r.target.expandable ? nav.open({ kind: 'node', id: r.target.id }) : setOpen(!open))}
          title={r.target.expandable ? 'Open' : r.note}
        >
          <span class={`row-label${r.target.expandable ? ' link' : ''}`}>{r.target.label}</span>
          {r.target.detail ? <span class="row-detail">{r.target.detail}</span> : <span class="row-kind">{RELATION_VERB[r.kind]}</span>}
        </button>
        {r.sites && r.sites > 1 ? <span class="row-kind">×{r.sites}</span> : null}
        <Badge evidence={r.evidence} />
        <Loc source={r.target.source} />
      </div>
      {open && r.note ? <div class="row-note">{r.note}</div> : null}
      {open && canExpand ? <Children id={r.target.id} depth={depth + 1} seen={new Set([...seen, r.target.id])} /> : null}
      {cycle && open ? <div class="row-note">Already shown above (recursive relationship).</div> : null}
    </li>
  );
}

function Children({ id, depth, seen }: { id: string; depth: number; seen: Set<string> }) {
  const state = useAsync(() => api.node(id), [id]);
  if (state.loading) return <div class="row-note">Loading…</div>;
  if (state.error) return <div class="row-note">{state.error}</div>;
  return <RelationList relations={state.data!.relations} depth={depth} seen={seen} />;
}

// ---------------------------------------------------------------- small pieces

export function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul class="notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

export function Loading({ label = 'Analysing…' }: { label?: string }) {
  return (
    <div class="loading">
      <span class="spinner" />
      {label}
    </div>
  );
}

export function NodeLink({ node }: { node: GraphNode }) {
  const nav = useNav();
  return (
    <button class="link-btn" onClick={() => nav.open({ kind: 'node', id: node.id })}>
      {node.label}
    </button>
  );
}
