import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Flow, TraceResult } from '@tracenaut/protocol';
import { api, onConnection } from '../api.js';
import { describe, snapshot, type ElementSnapshot } from '../adapters.js';
import { recorder, type RecorderState } from '../runtime.js';
import { Badge, Icon, NavContext, type View } from './common.js';
import { ElementView, HomeView, NodeView, TraceView, type ElementEntry } from './views.js';
import { CERTAINTY, CertaintyGuide, JourneyView, type WatchControl } from './journey.js';
import { ExplainProvider } from '../learn/explain.js';
import { ErrorBox, Loading, useAsync } from './common.js';
import { Icon3D } from './icon3d.js';

const WIDTH_KEY = 'tracenaut:width';
const MODE_KEY = 'tracenaut:mode';

type Mode = 'guided' | 'technical';

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'technical' ? 'technical' : 'guided';
  } catch {
    return 'guided';
  }
}

function loadWidth() {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w >= 340 && w <= 900) return w;
  } catch {
    // storage unavailable: use the default
  }
  return 480;
}

/** Failures are shown by the views that use these promises; one may never be looked at. */
function quiet(entry: ElementEntry) {
  entry.journey.catch(() => undefined);
  entry.result.catch(() => undefined);
}

/** How many views Back can return to. */
const HISTORY_MAX = 50;

/** The innermost element at a point, looking inside open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

export function App({ host }: { host: HTMLElement }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(loadWidth);
  const [history, setHistory] = useState<View[]>([{ kind: 'home' }]);
  const [index, setIndex] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Element } | null>(null);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<Element | null>(null);
  const [flash, setFlash] = useState<Element | null>(null);
  const [recState, setRecState] = useState<RecorderState>(recorder.state);
  const [connected, setConnected] = useState<boolean>();
  const [stale, setStale] = useState(false);
  const [editor, setEditor] = useState('vscode');
  const elements = useRef(new Map<number, ElementEntry>());
  const traces = useRef(new Map<number, { result?: TraceResult; error?: string; compare?: Flow; snap?: ElementSnapshot }>());
  const [mode, setModeState] = useState<Mode>(loadMode);
  const panelRef = useRef<HTMLElement>(null);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // per-viewer preference only
    }
  };
  const technical = mode === 'technical';
  const [, force] = useState(0);
  const keySeq = useRef(0);
  const lastContextTarget = useRef<Element | null>(null);
  /** The recording in progress, kept even before its view opens. */
  const pendingTrace = useRef<number>();

  const isOwnUi = useCallback((e: Event) => e.composedPath().includes(host), [host]);

  useEffect(() => {
    recorder.isOwnUi = isOwnUi;
    return recorder.subscribe(setRecState);
  }, [isOwnUi]);

  useEffect(() => {
    api.status().then(
      (s) => {
        setConnected(true);
        setEditor(s.editor);
      },
      () => setConnected(false),
    );
    return onConnection((c) => {
      if (c === 'stale') setStale(true);
      else setConnected(c === 'ok');
    });
  }, []);

  // While the daemon is unreachable, check now and then so the panel recovers by itself.
  useEffect(() => {
    if (connected !== false) return;
    const t = setInterval(() => api.status().then(() => setConnected(true), () => undefined), 5000);
    return () => clearInterval(t);
  }, [connected]);

  // The panel never exceeds the window. On wide windows it docks (the page reflows beside
  // it); on narrow ones it overlays the page so the app keeps a usable width.
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const dock = viewport >= 980;
  const panelWidth = Math.max(Math.min(340, viewport), Math.min(width, dock ? viewport - 420 : viewport - 16));

  useEffect(() => {
    if (!open || !dock) return;
    const style = document.createElement('style');
    style.setAttribute('data-tracenaut', 'dock');
    style.textContent = `html { margin-right: ${panelWidth}px !important; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [open, dock, panelWidth]);

  const [legend, setLegend] = useState(false);

  const nav_ = { history: useRef(history), index: useRef(index) };
  nav_.history.current = history;
  nav_.index.current = index;
  const view = history[index];
  const nav = useMemo(
    () => ({
      editor,
      open(next: View) {
        // Read through refs: a recording that finishes later must not reopen an old history.
        const kept = [...nav_.history.current.slice(0, nav_.index.current + 1), next].slice(-HISTORY_MAX);
        nav_.history.current = kept;
        nav_.index.current = kept.length - 1;
        setHistory(kept);
        setIndex(kept.length - 1);
        setOpen(true);
        // Forget inspections and recordings that dropped out of the history, so a long
        // session does not keep every journey (and its element snapshot) in memory.
        const keys = new Set(kept.map((v) => ('key' in v ? v.key : undefined)));
        for (const map of [elements.current, traces.current] as Map<number, unknown>[]) for (const k of map.keys()) if (!keys.has(k) && k !== pendingTrace.current) map.delete(k);
      },
    }),
    [editor],
  );

  const inspect = useCallback(
    (el: Element) => {
      api.invalidate();
      const request = describe(el);
      const key = ++keySeq.current;
      const journey = api.journey(request);
      const entry: ElementEntry = {
        request,
        journey,
        result: journey.then((j) => j.inspect),
        el: new WeakRef(el),
        snap: snapshot(el),
        reload() {
          entry.journey = api.journey(request);
          entry.result = entry.journey.then((j) => j.inspect);
          quiet(entry);
        },
      };
      quiet(entry);
      elements.current.set(key, entry);
      nav.open({ kind: 'element', key });
      setFlash(el);
      setTimeout(() => setFlash((f) => (f === el ? null : f)), 1400);
    },
    [nav],
  );

  /**
   * Record the next interaction. Started from a journey (`compare`), the journey stays on
   * screen while armed and the observed journey opens when the recording is ready.
   */
  const traceNext = useCallback(
    async (compare?: Flow, snap?: ElementSnapshot) => {
      const key = ++keySeq.current;
      pendingTrace.current = key;
      traces.current.set(key, { compare, snap });
      if (!compare) nav.open({ kind: 'trace', key });
      try {
        const { traceId } = await api.startTrace();
        const payload = await recorder.arm(traceId);
        if (!payload) {
          if (!compare) traces.current.set(key, { error: 'Recording cancelled.' });
          return;
        }
        const result = await api.finishTrace(traceId, payload);
        traces.current.set(key, { result, compare, snap });
        if (compare) nav.open({ kind: 'trace', key });
      } catch (err) {
        traces.current.set(key, { error: String((err as Error).message ?? err), compare, snap });
        if (compare) nav.open({ kind: 'trace', key });
      } finally {
        if (pendingTrace.current === key) pendingTrace.current = undefined;
        recorder.done();
        force((n) => n + 1);
      }
    },
    [nav],
  );

  const watch: WatchControl = {
    phase: recState.phase,
    start: (flow, snap) => traceNext(flow, snap),
    cancel: () => recorder.cancel(),
  };

  // ---- global page listeners (capture phase; inert unless the user asks for TraceNaut)
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (isOwnUi(e)) return;
      // Inside open shadow roots (web components) `target` is the host; the first entry
      // of the composed path is the element actually under the pointer.
      const first = e.composedPath()[0];
      const target = first instanceof Element ? first : e.target instanceof Element ? e.target : null;
      if (!target) return;
      lastContextTarget.current = target;
      if (!e.altKey) return; // the normal context menu stays untouched
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 250), y: Math.min(e.clientY, window.innerHeight - 110), target });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyI') {
        e.preventDefault();
        setPicking((p) => !p);
      } else if (e.altKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        traceNext();
      } else if (e.key === 'Escape' && !picking) {
        setMenu(null);
        setPicking(false);
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.data?.source !== 'tracenaut-extension') return;
      const target = lastContextTarget.current;
      if (e.data.action === 'inspect' && target) inspect(target);
      if (e.data.action === 'trace') traceNext();
    };
    const onDown = (e: MouseEvent) => {
      if (!isOwnUi(e)) setMenu(null);
    };
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('message', onMessage);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [inspect, traceNext, isOwnUi, picking]);

  // ---- element picker
  useEffect(() => {
    if (!picking) {
      setHover(null);
      return;
    }
    const move = (e: MouseEvent) => {
      if (isOwnUi(e)) return;
      const el = deepElementFromPoint(e.clientX, e.clientY);
      if (el) setHover(el);
    };
    const swallow = (e: Event) => {
      if (isOwnUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const click = (e: MouseEvent) => {
      if (isOwnUi(e)) return;
      swallow(e);
      const el = deepElementFromPoint(e.clientX, e.clientY);
      setPicking(false);
      if (el) inspect(el);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('pointerdown', swallow, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('pointerdown', swallow, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('click', click, true);
    };
  }, [picking, inspect, isOwnUi]);

  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev: PointerEvent) => setWidth(Math.max(340, Math.min(900, startW + startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // ignore
        }
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const highlighted = hover ?? flash;
  const recording = recState.phase === 'armed' || recState.phase === 'recording';

  return (
    <NavContext.Provider value={nav}>
      <div class="root">
        {highlighted ? <Highlight el={highlighted} /> : null}
        {picking ? <div class="picker-banner">Click an element to inspect it · Esc to cancel</div> : null}

        {menu ? (
          <div class="menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
            <div class="menu-title">{label(menu.target)}</div>
            <button
              class="menu-item"
              role="menuitem"
              autoFocus
              onClick={() => {
                setMenu(null);
                inspect(menu.target);
              }}
            >
              {Icon.pick()} Inspect with TraceNaut <span class="hint">Alt⇧I</span>
            </button>
            <button
              class="menu-item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                traceNext();
              }}
            >
              {Icon.rec()} Trace next action <span class="hint">Alt⇧T</span>
            </button>
          </div>
        ) : null}

        {open ? (
          <aside class={`panel ${mode}${dock ? '' : ' overlay'}`} style={{ width: `${panelWidth}px` }} aria-label="TraceNaut" ref={panelRef}>
            <div class="resize" onPointerDown={startResize} />
            <div class="head">
              <div class="brand">
                <Icon3D name="brand-mark" size={22} />
                TraceNaut
              </div>
              <button class="icon-btn" title="Back" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                {Icon.back()}
              </button>
              <button class="icon-btn" title="Forward" disabled={index >= history.length - 1} onClick={() => setIndex(index + 1)}>
                {Icon.fwd()}
              </button>
              <span class="spacer" />
              <div class="mode-switch" role="radiogroup" aria-label="Level of detail">
                <button role="radio" aria-checked={!technical} class={!technical ? 'on' : ''} onClick={() => setMode('guided')} title="Plain-language journeys and explanations">
                  Guided
                </button>
                <button role="radio" aria-checked={technical} class={technical ? 'on' : ''} onClick={() => setMode('technical')} title="The full inspector: functions, files and evidence">
                  Technical
                </button>
              </div>
              <button class="icon-btn" title="Pick an element to explore (Alt+Shift+I)" aria-label="Pick an element" onClick={() => setPicking(true)}>
                {Icon.pick()}
              </button>
              <button
                class={`icon-btn${recording ? ' rec-on' : ''}`}
                title={recording ? 'Cancel recording' : 'Watch your next action happen (Alt+Shift+T)'}
                aria-label={recording ? 'Cancel recording' : 'Watch it happen'}
                onClick={() => (recording ? recorder.cancel() : traceNext())}
              >
                {Icon.rec()}
              </button>
              <button class={`icon-btn${legend ? ' on' : ''}`} title="How sure is TraceNaut?" aria-label="How sure is TraceNaut?" aria-expanded={legend} onClick={() => setLegend(!legend)}>
                {Icon.info()}
              </button>
              <button class="icon-btn" title="Close" aria-label="Close" onClick={() => setOpen(false)}>
                {Icon.close()}
              </button>
            </div>
            {legend ? (
              <div class="legend-panel">
                {technical ? (
                  <ul class="cert-guide">
                    {(['runtime', 'static', 'inferred', 'unresolved'] as const).map((e) => (
                      <li key={e}>
                        <Badge evidence={e} />
                        <span>{CERTAINTY[e].help}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <CertaintyGuide />
                )}
              </div>
            ) : null}
            <ExplainProvider bounds={() => panelRef.current?.getBoundingClientRect()}>
              <ScrollBody>
                {view.kind === 'home' ? <HomeView connected={connected} stale={stale} technical={technical} /> : null}
                {view.kind === 'element' && technical ? (
                  <ElementView key={view.key} entry={elements.current.get(view.key)!} highlight={(el) => setHover(el ?? null)} />
                ) : null}
                {view.kind === 'element' && !technical ? <ElementJourney key={view.key} entry={elements.current.get(view.key)!} watch={watch} /> : null}
                {view.kind === 'node' ? <NodeView key={view.id} id={view.id} /> : null}
                {view.kind === 'trace' && technical ? (
                  <TraceView state={recState} result={traces.current.get(view.key)?.result} error={traces.current.get(view.key)?.error} onCancel={() => recorder.cancel()} />
                ) : null}
                {view.kind === 'trace' && !technical ? (
                  traces.current.get(view.key)?.result?.flow ? (
                    <JourneyView
                      key={view.key}
                      flows={[traces.current.get(view.key)!.result!.flow!]}
                      compare={traces.current.get(view.key)?.compare}
                      preview={traces.current.get(view.key)?.snap}
                      technical={false}
                    />
                  ) : (
                    <TraceView state={recState} error={traces.current.get(view.key)?.error} onCancel={() => recorder.cancel()} />
                  )
                ) : null}
              </ScrollBody>
            </ExplainProvider>
          </aside>
        ) : null}

        {!open ? (
          <button class="launcher" onClick={() => setOpen(true)} title={connected === false ? 'TraceNaut daemon not reachable' : 'Open TraceNaut (Alt+right-click any element)'}>
            <Icon3D name="brand-mark" size={20} />
            TraceNaut
            <span class={`dot${recording ? ' rec' : connected === false ? ' off' : ''}`} />
            {recording ? <kbd>recording</kbd> : null}
          </button>
        ) : null}
      </div>
    </NavContext.Provider>
  );
}

function ElementJourney({ entry, watch }: { entry: ElementEntry; watch: WatchControl }) {
  const state = useAsync(() => entry.journey, [entry]);
  if (state.loading) return <Loading label="Working out what this does…" />;
  if (state.error)
    return (
      <ErrorBox
        message={state.error}
        onRetry={
          state.canRetry
            ? () => {
                entry.reload();
                state.retry();
              }
            : undefined
        }
      />
    );
  const withSnapshot: WatchControl = { ...watch, start: (flow) => watch.start(flow, entry.snap) };
  return <JourneyView flows={state.data!.flows} watch={withSnapshot} technical={false} preview={entry.snap} />;
}

/**
 * The panel's single scroll area. It contains scrolling (no page scroll-chaining) and
 * shows a "more below" cue, because macOS hides scrollbars until you scroll.
 */
function ScrollBody({ children }: { children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 24));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      update();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <>
      <div class="body" ref={ref}>
        {children}
      </div>
      {more ? (
        <>
          <div class="more-fade" aria-hidden="true" />
          <button
            class="more-below"
            title="More below"
            aria-label="Scroll down for more"
            onClick={() => ref.current?.scrollBy({ top: ref.current.clientHeight * 0.7, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
          >
            ↓
          </button>
        </>
      ) : null}
    </>
  );
}

function label(el: Element) {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
  return `<${tag}>${text ? ` “${text}”` : ''}`;
}

function Highlight({ el }: { el: Element }) {
  const [rect, setRect] = useState(() => el.getBoundingClientRect());
  useEffect(() => {
    // Follow the element every frame while highlighted: the page reflows when the panel docks.
    let frame = 0;
    const update = () => {
      const r = el.getBoundingClientRect();
      setRect((prev) => (prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height ? prev : r));
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [el]);
  if (!el.isConnected) return null;
  const loc = describe(el).chain[0];
  return (
    <div class="highlight" style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }}>
      <span class="highlight-label">
        {el.tagName.toLowerCase()}
        {loc ? ` · ${loc.loc.split('/').pop()}` : ''}
      </span>
    </div>
  );
}
