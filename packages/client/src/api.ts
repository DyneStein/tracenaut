import type { FrontendTracePayload, InspectRequest, InspectResult, JourneyResult, NodeDetail, Relation, StackResult, StatusResult, TraceResult } from '@tracenaut/protocol';
import { nativeFetch } from './runtime.js';

export interface ClientConfig {
  daemon: string;
  token: string;
  repoRoot: string;
  /** Asset-set version, so icons can be cached forever. */
  assets?: string;
}

export const config: ClientConfig | undefined = (window as unknown as { __TRACENAUT_CONFIG__?: ClientConfig }).__TRACENAUT_CONFIG__;

/** 'ok', 'offline' (daemon not reachable) or 'stale' (the daemon restarted with a new access key). */
export type Connection = 'ok' | 'offline' | 'stale';
const listeners = new Set<(c: Connection) => void>();
export function onConnection(fn: (c: Connection) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const report = (c: Connection) => listeners.forEach((fn) => fn(c));

/** An error a person can act on; `retry` says whether trying again can help. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config) throw new ApiError('TraceNaut is not configured on this page.', false);
  let res: Response;
  try {
    res = await nativeFetch(`${config.daemon}${path}`, {
      ...init,
      headers: { 'x-tracenaut-token': config.token, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch {
    report('offline');
    throw new ApiError('TraceNaut can’t reach its background program (the daemon). Check that `tracenaut start` is still running, then try again.', true);
  }
  if (res.status === 401) {
    report('stale');
    throw new ApiError('The TraceNaut daemon was restarted, so this page’s access key is out of date. Reload the page to reconnect.', false);
  }
  report('ok');
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new ApiError(body.error ?? `The daemon answered ${res.status}.`, res.status >= 500);
  return body as T;
}

const nodeCache = new Map<string, Promise<NodeDetail>>();

export const api = {
  status: () => call<StatusResult>('/api/status'),
  stack: () => call<StackResult>('/api/stack'),
  inspect: (req: InspectRequest) => call<InspectResult>('/api/inspect', { method: 'POST', body: JSON.stringify(req) }),
  journey: (req: InspectRequest) => call<JourneyResult>('/api/journey', { method: 'POST', body: JSON.stringify(req) }),
  node(id: string) {
    let p = nodeCache.get(id);
    if (!p) {
      p = call<NodeDetail>(`/api/node?id=${encodeURIComponent(id)}`);
      p.catch(() => nodeCache.delete(id));
      nodeCache.set(id, p);
    }
    return p;
  },
  callers: (id: string) => call<Relation[]>(`/api/callers?id=${encodeURIComponent(id)}`),
  startTrace: () => call<{ traceId: string; agents: { service: string; connected: boolean }[] }>('/api/trace/start', { method: 'POST', body: '{}' }),
  finishTrace: (id: string, payload: FrontendTracePayload) =>
    call<TraceResult>(`/api/trace/${id}/finish`, { method: 'POST', body: JSON.stringify(payload) }),
  /** Source can change while the page is open (HMR); drop cached node detail. */
  invalidate: () => nodeCache.clear(),
};
