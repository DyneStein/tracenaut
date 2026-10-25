import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon3D, KIND_ICON } from '../ui/icon3d.js';
import { concept, KIND_LABEL, type Concept, type ConceptKind } from './concepts.js';

/** App-specific context shown under a general explanation. */
export interface ExplainExtra {
  /** What it does in this app (from the journey's evidence). */
  role?: string;
  /** How TraceNaut identified it. */
  evidence?: string;
  /** For technologies without a curated card: data from the asset registry. */
  name?: string;
  kind?: string;
  what?: string;
  effect?: string;
  asset?: string;
  logo?: boolean;
}

interface Popover {
  id: string;
  anchor: Element;
  rect: DOMRect;
  extra?: ExplainExtra;
  pinned: boolean;
}

interface Explain {
  hover(id: string, el: Element, extra?: ExplainExtra): void;
  leave(): void;
  pin(id: string, el: Element, extra?: ExplainExtra): void;
}

const ExplainContext = createContext<Explain>({ hover() {}, leave() {}, pin() {} });
export const useExplain = () => useContext(ExplainContext);

const HOVER_DELAY = 140;

/** Hosts the single concept popover for the panel. */
export function ExplainProvider({ children, bounds }: { children: preact.ComponentChildren; bounds: () => DOMRect | undefined }) {
  const [pop, setPop] = useState<Popover | null>(null);
  const timer = useRef<number>();
  const overPopover = useRef(false);

  const api = useRef<Explain>({
    hover(id, el, extra) {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setPop((p) => (p?.pinned ? p : { id, anchor: el, rect: el.getBoundingClientRect(), extra, pinned: false }));
      }, HOVER_DELAY);
    },
    leave() {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!overPopover.current) setPop((p) => (p?.pinned ? p : null));
      }, 120);
    },
    pin(id, el, extra) {
      clearTimeout(timer.current);
      setPop((p) => (p?.pinned && p.id === id ? null : { id, anchor: el, rect: el.getBoundingClientRect(), extra, pinned: true }));
    },
  }).current;

  useEffect(() => {
    if (!pop?.pinned) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pop?.pinned]);

  return (
    <ExplainContext.Provider value={api}>
      <div
        onPointerDown={(e) => {
          if (pop?.pinned && !(e.target as Element).closest?.('.concept, .term, .tech-chip, .syn')) setPop(null);
        }}
        // Cards are anchored to a term. When the panel scrolls, the card follows its term and
        // closes once the term leaves the visible area.
        onScrollCapture={(e) => {
          const scroller = e.target as Element;
          if (scroller.closest?.('.concept')) return;
          setPop((p) => {
            if (!p) return p;
            const r = p.anchor.getBoundingClientRect();
            if (Math.abs(r.top - p.rect.top) < 1 && Math.abs(r.left - p.rect.left) < 1) return p;
            const view = scroller.getBoundingClientRect();
            const visible = p.anchor.isConnected && r.bottom > view.top && r.top < view.bottom;
            return visible ? { ...p, rect: r } : null;
          });
        }}
        class="explain-host"
      >
        {children}
      </div>
      {pop ? (
        <ConceptCard
          key={pop.id}
          pop={pop}
          bounds={bounds()}
          onClose={() => setPop(null)}
          onEnter={() => (overPopover.current = true)}
          onLeave={() => {
            overPopover.current = false;
            api.leave();
          }}
        />
      ) : null}
    </ExplainContext.Provider>
  );
}

function ConceptCard({ pop, bounds, onClose, onEnter, onLeave }: { pop: Popover; bounds?: DOMRect; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const curated = concept(pop.id);
  const x = pop.extra;
  const c: Concept | undefined = curated ?? (x?.what ? { name: x.name ?? pop.id, kind: (x.kind ?? 'idea') as ConceptKind, short: x.what } : undefined);
  const effect = x?.effect ?? curated?.effect;
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const width = Math.min(300, (bounds?.width ?? window.innerWidth) - 20);

  // Place the card after measuring it: below the anchor if it fits, else above, always
  // fully inside the window. Tall cards scroll internally instead of being clipped.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const h = Math.min(el.offsetHeight, window.innerHeight - 2 * margin);
    const left = Math.max((bounds?.left ?? 0) + 10, Math.min(pop.rect.left, (bounds?.right ?? window.innerWidth) - width - 10));
    const below = pop.rect.bottom + 6;
    const above = pop.rect.top - 6 - h;
    const top = below + h <= window.innerHeight - margin ? below : above >= margin ? above : Math.max(margin, window.innerHeight - margin - h);
    setPos({ left, top });
  }, [pop, more, width]);

  if (!c) return null;
  const kind = KIND_LABEL[c.kind as ConceptKind];
  return (
    <div
      ref={ref}
      class={`concept${pop.pinned ? ' pinned' : ''}`}
      style={{ left: `${pos?.left ?? -9999}px`, top: `${pos?.top ?? 0}px`, width: `${width}px`, visibility: pos ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label={c.name}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div class="concept-head">
        <Icon3D name={x?.asset ?? KIND_ICON[c.kind] ?? 'component'} size={32} />
        <div class="concept-titles">
          <span class={`kind-tag kind-${c.kind}`} title={kind.what}>
            {kind.label}
          </span>
          <div class="concept-name">{c.name}</div>
        </div>
        {pop.pinned ? (
          <button class="concept-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        ) : null}
      </div>
      <div class="concept-q">What is it?</div>
      <p class="concept-short">{c.short}</p>
      {c.example ? <code class="concept-example">{c.example}</code> : null}
      {x?.role ? (
        <div class="concept-app">
          <span>Why it's used here</span>
          {x.role}
        </div>
      ) : null}
      {effect && effect !== x?.role ? (
        <div class="concept-app">
          <span>What happens because of it</span>
          {effect}
        </div>
      ) : null}
      {x?.evidence ? (
        <div class="concept-app">
          <span>How TraceNaut knows</span>
          {x.evidence}
        </div>
      ) : null}
      {x?.logo ? <div class="concept-legal">Official logo, a trademark of its owner, shown only to identify the technology.</div> : null}
      {c.more ? (
        more ? (
          <p class="concept-more">{c.more}</p>
        ) : (
          <button class="concept-more-btn" onClick={() => setMore(true)}>
            More about {c.name} ›
          </button>
        )
      ) : null}
      {!pop.pinned ? <div class="concept-hint">Click to keep this open</div> : null}
    </div>
  );
}

/** An explainable term inside running text. */
export function Term({ id, children, extra }: { id: string; children: preact.ComponentChildren; extra?: ExplainExtra }) {
  const ex = useExplain();
  const known = !!concept(id);
  const handlers = useCallback(
    () => ({
      onMouseEnter: (e: MouseEvent) => ex.hover(id, e.currentTarget as Element, extra),
      onMouseLeave: () => ex.leave(),
      onFocus: (e: FocusEvent) => ex.hover(id, e.currentTarget as Element, extra),
      onBlur: () => ex.leave(),
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        ex.pin(id, e.currentTarget as Element, extra);
      },
    }),
    [id, extra],
  );
  if (!known) return <>{children}</>;
  return (
    <button class="term" data-concept={id} {...handlers()}>
      {children}
    </button>
  );
}

/** Renders text with [[label|conceptId]] markup as explainable terms. */
export function Rich({ text }: { text: string }) {
  const parts: preact.ComponentChildren[] = [];
  const re = /\[\[([^|\]]+)\|([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Term key={k++} id={m[2]}>
        {m[1]}
      </Term>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Strip markup for places that need plain text (titles, tooltips). */
export function plain(text: string) {
  return text.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, '$1');
}
