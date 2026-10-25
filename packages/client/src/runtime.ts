import { createProbeRuntime, newProbeContext, RUNTIME_GLOBAL, type ProbeContext } from '@tracenaut/instrument/runtime';
import { type ActionRecord, type ClientRequestRecord, type FrontendTracePayload, redactQuery } from '@tracenaut/protocol';

/**
 * Browser half of runtime tracing. Installed synchronously before the app's modules
 * run, so instrumented code finds the real runtime. Nothing is recorded until a trace
 * is armed and the user performs the next interaction.
 */

const now = () => performance.now();
let ctx: ProbeContext | null = null;
export const runtime = createProbeRuntime(() => ctx ?? undefined, now);
(window as unknown as Record<string, unknown>)[RUNTIME_GLOBAL] = runtime;

/** Unpatched fetch for TraceNaut's own calls. */
export const nativeFetch = window.fetch.bind(window);

type Listener = (state: RecorderState) => void;
export type RecorderState =
  | { phase: 'idle' }
  | { phase: 'armed' }
  | { phase: 'recording'; calls: number; requests: number }
  | { phase: 'finishing' };

const ACTION_EVENTS = ['pointerdown', 'keydown', 'submit', 'change', 'input', 'click'] as const;
const QUIET_MS = 700;
const MAX_MS = 12_000;
const ARM_TIMEOUT_MS = 90_000;

class Recorder {
  state: RecorderState = { phase: 'idle' };
  private traceId = '';
  private seq = 0;
  private requests: ClientRequestRecord[] = [];
  private pending = 0;
  private action?: ActionRecord;
  private actionEvents: string[] = [];
  private startedAt = 0;
  private lastChange = 0;
  private lastSize = 0;
  private timer?: number;
  private armTimer?: number;
  private listeners = new Set<Listener>();
  private resolve?: (p: FrontendTracePayload | null) => void;
  /** Elements inside TraceNaut's own UI are never treated as the user's action. */
  isOwnUi: (e: Event) => boolean = () => false;
  locate: (el: Element) => string | undefined = () => undefined;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: RecorderState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  get recording() {
    return this.state.phase === 'recording';
  }

  get id() {
    return this.traceId;
  }

  /** Resolves with the recorded payload once the action settles, or null if cancelled. */
  arm(traceId: string): Promise<FrontendTracePayload | null> {
    this.cancel();
    this.traceId = traceId;
    this.seq = 0;
    this.requests = [];
    this.pending = 0;
    this.action = undefined;
    this.actionEvents = [];
    this.dispatched = [];
    for (const type of ACTION_EVENTS) window.addEventListener(type, this.onEvent, true);
    this.armTimer = window.setTimeout(() => this.cancel(), ARM_TIMEOUT_MS);
    this.set({ phase: 'armed' });
    return new Promise((resolve) => (this.resolve = resolve));
  }

  cancel() {
    this.stopListening();
    ctx = null;
    if (this.state.phase !== 'idle') this.set({ phase: 'idle' });
    this.resolve?.(null);
    this.resolve = undefined;
  }

  private stopListening() {
    for (const type of ACTION_EVENTS) window.removeEventListener(type, this.onEvent, true);
    clearInterval(this.timer);
    clearTimeout(this.armTimer);
  }

  /** The user's events seen so far; while one is mid-dispatch its eventPhase is not NONE. */
  private dispatched: Event[] = [];
  private inEvent = () => this.dispatched.some((e) => e.eventPhase !== Event.NONE);

  private onEvent = (e: Event) => {
    if (this.isOwnUi(e)) return;
    if (this.state.phase !== 'idle' && this.dispatched.length < 12) this.dispatched.push(e);
    if (e.type === 'keydown' && ['Shift', 'Alt', 'Meta', 'Control', 'Tab'].includes((e as KeyboardEvent).key)) return;
    if (this.state.phase === 'armed') this.begin(e);
    if (this.state.phase === 'recording' && this.actionEvents.length < 6 && this.actionEvents.at(-1) !== e.type) {
      this.actionEvents.push(e.type);
      this.action!.type = this.actionEvents.join(' → ');
    }
  };

  private begin(e: Event) {
    clearTimeout(this.armTimer);
    const target = e.target instanceof Element ? e.target : null;
    this.startedAt = now();
    this.lastChange = this.startedAt;
    this.lastSize = 0;
    this.action = {
      type: e.type,
      at: this.startedAt,
      tag: target?.tagName.toLowerCase() ?? '?',
      text: (target?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      loc: target ? this.locate(target) : undefined,
    };
    ctx = newProbeContext();
    ctx.inEvent = this.inEvent;
    this.set({ phase: 'recording', calls: 0, requests: 0 });
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private tick() {
    const size = (ctx?.calls.length ?? 0) + this.requests.length * 1000 + this.pending;
    const t = now();
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.lastChange = t;
      this.set({ phase: 'recording', calls: ctx?.calls.length ?? 0, requests: this.requests.length });
    }
    const quiet = this.pending === 0 && t - this.lastChange > QUIET_MS;
    if (quiet || t - this.startedAt > MAX_MS) this.finish();
  }

  private finish() {
    this.stopListening();
    const recorded = ctx;
    ctx = null;
    this.set({ phase: 'finishing' });
    const payload: FrontendTracePayload = {
      action: this.action,
      eventMarks: true,
      calls: recorded?.calls ?? [],
      requests: this.requests,
      dropped: recorded?.dropped ?? 0,
      durationMs: now() - this.startedAt,
    };
    this.resolve?.(payload);
    this.resolve = undefined;
  }

  done() {
    this.set({ phase: 'idle' });
  }

  /** Called by the fetch/XHR patches for every request made while recording. */
  track(method: string, rawUrl: string): { record: ClientRequestRecord; header?: string } {
    const abs = new URL(rawUrl, location.href);
    const sameOrigin = abs.origin === location.origin;
    const record: ClientRequestRecord = {
      seq: ++this.seq,
      method: method.toUpperCase(),
      // Sensitive query values (tokens, keys, codes…) never leave the page.
      url: sameOrigin ? redactQuery(abs.pathname + abs.search) : redactQuery(abs.origin + abs.pathname + abs.search),
      initiator: runtime.current(),
      at: now(),
      correlated: sameOrigin,
    };
    this.requests.push(record);
    this.pending++;
    return { record, header: sameOrigin ? `${this.traceId}:${record.seq}` : undefined };
  }

  settle(record: ClientRequestRecord, status?: number, error?: string) {
    record.end = now();
    record.status = status;
    record.error = error;
    this.pending = Math.max(0, this.pending - 1);
  }
}

export const recorder = new Recorder();

// --- request observation ----------------------------------------------------------------

window.fetch = function tracedFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!recorder.recording) return nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const { record, header } = recorder.track(method, url);
  let nextInit = init;
  if (header) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-tracenaut-trace', header);
    nextInit = { ...init, headers };
  }
  return nativeFetch(input, nextInit).then(
    (res) => {
      recorder.settle(record, res.status);
      return res;
    },
    (err) => {
      recorder.settle(record, undefined, String(err?.message ?? err));
      throw err;
    },
  );
};

const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
const xhrInfo = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  xhrInfo.set(this, { method, url: String(url) });
  return (xhrOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const info = xhrInfo.get(this);
  if (recorder.recording && info) {
    const { record, header } = recorder.track(info.method, info.url);
    if (header) this.setRequestHeader('x-tracenaut-trace', header);
    this.addEventListener('loadend', () => recorder.settle(record, this.status || undefined, this.status ? undefined : 'network error'), { once: true });
  }
  return xhrSend.call(this, body);
};
