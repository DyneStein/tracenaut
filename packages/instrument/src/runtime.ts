/**
 * The probe runtime that instrumented code calls into (`globalThis.__TRACENAUT__`).
 * Shared by the browser client and the Node agent; they differ only in how the
 * current trace context is found (a single armed trace vs. AsyncLocalStorage).
 */

export const RUNTIME_GLOBAL = '__TRACENAUT__';

export interface ProbeCall {
  /** Unique token for this invocation. */
  t: number;
  /** Probe id: `file|line|col|kind|name`. */
  id: string;
  /** Token of the invocation that was on top of the stack when this one started; 0 = root. */
  parent: number;
  at: number;
  end?: number;
  /** Root calls only: started while the recorded user event was being dispatched. */
  ev?: true;
}

export interface ProbeContext {
  calls: ProbeCall[];
  stack: number[];
  limit: number;
  dropped: number;
  /** Asked when a root call starts: is the user's event being dispatched right now? */
  inEvent?: () => boolean;
}

export interface ProbeRuntime {
  e(id: string): number;
  x(token: number): void;
  s<T>(token: number, value: T): T;
  r<T>(token: number, value: T): T;
  k(token: number): void;
  /** Token currently on top of the stack, used to attribute side effects (requests, SQL). */
  current(): number;
}

export function newProbeContext(limit = 5000): ProbeContext {
  return { calls: [], stack: [], limit, dropped: 0 };
}

export function createProbeRuntime(getContext: () => ProbeContext | undefined, now: () => number): ProbeRuntime {
  let seq = 0;

  function remove(stack: number[], token: number) {
    const i = stack.lastIndexOf(token);
    if (i !== -1) stack.splice(i, 1);
  }

  return {
    e(id) {
      const ctx = getContext();
      if (!ctx) return 0;
      if (ctx.calls.length >= ctx.limit) {
        ctx.dropped++;
        return 0;
      }
      const t = ++seq;
      const parent = ctx.stack.length ? ctx.stack[ctx.stack.length - 1] : 0;
      const call: ProbeCall = { t, id, parent, at: now() };
      if (!parent && ctx.inEvent?.()) call.ev = true;
      ctx.calls.push(call);
      ctx.stack.push(t);
      return t;
    },
    x(token) {
      if (!token) return;
      const ctx = getContext();
      if (!ctx) return;
      remove(ctx.stack, token);
      const call = findCall(ctx, token);
      if (call && call.end === undefined) call.end = now();
    },
    s(token, value) {
      if (token) {
        const ctx = getContext();
        if (ctx) remove(ctx.stack, token);
      }
      return value;
    },
    r(token, value) {
      if (token) {
        const ctx = getContext();
        if (ctx && ctx.stack[ctx.stack.length - 1] !== token) ctx.stack.push(token);
      }
      return value;
    },
    k(token) {
      if (!token) return;
      const ctx = getContext();
      if (ctx && !ctx.stack.includes(token)) ctx.stack.push(token);
    },
    current() {
      const ctx = getContext();
      return ctx && ctx.stack.length ? ctx.stack[ctx.stack.length - 1] : 0;
    },
  };
}

function findCall(ctx: ProbeContext, token: number) {
  // Calls are appended in token order, so search from the end.
  for (let i = ctx.calls.length - 1; i >= 0; i--) {
    if (ctx.calls[i].t === token) return ctx.calls[i];
    if (ctx.calls[i].t < token) return undefined;
  }
  return undefined;
}
