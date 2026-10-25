/**
 * TraceNaut Node agent — explicitly opt-in:  node --import @tracenaut/node-agent server.js
 *
 * What it does, and nothing more:
 *  - Adds inactive trace probes to *your* modules inside the repository (never node_modules),
 *    keeping line numbers intact and emitting source maps for stack traces.
 *  - When the daemon arms a trace, records calls and SQL statements, but only for HTTP
 *    requests that carry that trace's header (requests made by the traced browser action).
 *  - Never records request bodies, headers, SQL parameter values or return values.
 */
import { registerHooks, createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { type AgentOutgoingRecord, type AgentRequestRecord, type AgentSqlRecord, redactQuery } from '@tracenaut/protocol';
import { createHook, executionAsyncId } from 'node:async_hooks';
import diagnostics from 'node:diagnostics_channel';
import { observeDatabaseSockets, redactSql } from './wire.js';
import { createProbeRuntime, instrumentSync, isInstrumentable, newProbeContext, RUNTIME_GLOBAL, type ProbeContext } from '@tracenaut/instrument';

interface Session {
  port: number;
  token: string;
  repoRoot: string;
}

interface Store {
  ctx: ProbeContext;
  rec: AgentRequestRecord;
}

const log = (msg: string) => console.log(`[tracenaut-agent] ${msg}`);
const DEBUG = process.env.TRACENAUT_DEBUG === '1';
const STATIC_REQUEST = /^\/(_next\/(static|webpack-hmr|image)|__nextjs|@vite\/|@fs\/|@id\/|node_modules\/|favicon\.ico)|\.(m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)(\?|$)/;
const GENERATED = /[\\/](\.next|\.nuxt|\.svelte-kit|\.output|\.vercel|\.turbo|\.cache)[\\/]/;

function readSession(): Session | undefined {
  const file = path.join(process.env.TRACENAUT_HOME ?? path.join(homedir(), '.tracenaut'), 'daemon.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const initialSession = readSession();
const scopeRoot = path.resolve(process.env.TRACENAUT_ROOT ?? initialSession?.repoRoot ?? process.cwd());
const als = new AsyncLocalStorage<Store>();
const now = () => performance.now();
const runtime = createProbeRuntime(() => als.getStore()?.ctx, now);
(globalThis as Record<string, unknown>)[RUNTIME_GLOBAL] = runtime;

/** The armed trace: its requests, and statements seen during it that no request can claim. */
let active: { traceId: string; requests: AgentRequestRecord[]; unattributed: AgentSqlRecord[] } | null = null;

// --- 1. Instrument the user's modules -------------------------------------------------

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:sqlite' || specifier === 'sqlite') queueMicrotask(patchSqlite);
    const resolved = nextResolve(specifier, context);
    // Database drivers are patched right after the app first loads them, from the same file
    // the app resolved (so the app's copy is the one observed).
    const driver = DRIVERS[specifier];
    if (driver && resolved.url.startsWith('file:') && !patchedDrivers.has(resolved.url)) {
      patchedDrivers.add(resolved.url);
      queueMicrotask(() => {
        try {
          driver(createRequire(resolved.url)(fileURLToPath(resolved.url)));
        } catch (err) {
          log(`could not observe ${specifier}: ${(err as Error).message}`);
        }
      });
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || (result.format !== 'module' && result.format !== 'commonjs')) return result;
    const file = fileURLToPath(url);
    // Bundler output (.next, .nuxt, …) is generated code; when it was built with TraceNaut's
    // bundler plugin it is already instrumented, with locations in the original sources.
    if (!isInstrumentable(file) || !file.startsWith(scopeRoot + path.sep) || GENERATED.test(file)) return result;
    const source = result.source == null ? readFileSync(file, 'utf8') : typeof result.source === 'string' ? result.source : Buffer.from(result.source as Uint8Array).toString('utf8');
    try {
      const rel = path.relative(scopeRoot, file).split(path.sep).join('/');
      const out = instrumentSync(source, file, { file: rel, probes: true }, { retainLines: true, sourceMaps: 'inline' });
      return out?.code ? { ...result, source: out.code } : result;
    } catch (err) {
      log(`could not instrument ${file}: ${(err as Error).message} (loaded unmodified)`);
      return result;
    }
  },
});
process.setSourceMapsEnabled(true);

// --- 2. Correlate incoming HTTP requests with the armed trace --------------------------

const emit = http.Server.prototype.emit as (this: http.Server, ...a: unknown[]) => boolean;
/** HTTP requests being handled right now, traced or not (to judge queued statements). */
const inFlight = { untraced: 0 };

http.Server.prototype.emit = function (this: http.Server, event: string, ...args: unknown[]) {
  if (event === 'request' && active) {
    const incoming = args[0] as http.IncomingMessage;
    const header = incoming.headers['x-tracenaut-trace'];
    // Static files and dev-server plumbing (bundles, hot reload) do not run the app's code, so
    // they do not make a queued database statement ambiguous.
    const asset = STATIC_REQUEST.test(incoming.url ?? '');
    if (!asset && (typeof header !== 'string' || !header.includes(`${active.traceId}:`))) {
      inFlight.untraced++;
      (args[1] as http.ServerResponse).once('close', () => inFlight.untraced--);
    }
  }
  if (event === 'request' && active) {
    const [req, res] = args as [http.IncomingMessage & { route?: { path?: string }; baseUrl?: string }, http.ServerResponse];
    const header = req.headers['x-tracenaut-trace'];
    // Frameworks may forward the incoming header on their own internal requests, and the agent
    // then appends a nested key ("t:1, t:1.1"): the last entry for this trace is this request.
    const entry = typeof header === 'string' ? header.split(',').map((h) => h.trim()).reverse().find((h) => h.startsWith(`${active!.traceId}:`)) : undefined;
    const [traceId, seq] = entry ? entry.split(':') : [];
    if (traceId === active.traceId) {
      const ctx = newProbeContext();
      // `seq` is the browser request (`3`), or a call from another traced service (`3.1`).
      if (DEBUG) log(`traced request ${seq}: ${req.method} ${req.url}`);
      const rec: AgentRequestRecord = { seq: parseInt(seq, 10), key: seq, method: req.method ?? 'GET', url: redactQuery(req.url ?? '/'), at: now(), calls: ctx.calls, sql: [], dropped: 0 };
      active.requests.push(rec);
      const origEnd = res.end;
      res.end = function (this: http.ServerResponse, ...endArgs: unknown[]) {
        // Read the framework's matched route while the handler is still in charge of req.
        const route = req.route?.path;
        if (typeof route === 'string' && !rec.route) rec.route = `${rec.method} ${joinPath(req.baseUrl ?? '', route)}`;
        return (origEnd as (...a: unknown[]) => http.ServerResponse).apply(this, endArgs);
      } as typeof res.end;
      res.on('finish', () => {
        rec.status = res.statusCode;
        rec.durationMs = Math.round((now() - rec.at) * 10) / 10;
        rec.dropped = ctx.dropped;
      });
      return als.run({ ctx, rec }, () => emit.call(this, event, ...args));
    }
  }
  return emit.call(this, event, ...args);
} as typeof http.Server.prototype.emit;

function joinPath(a: string, b: string) {
  const clean = `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`.replace(/\/+/g, '/');
  return clean.length > 1 ? clean.replace(/\/$/, '') : clean;
}

// --- 3. Observe SQL statements (text only; parameter values are never read) ------------
//   node:sqlite, better-sqlite3 (synchronous statements) and pg (asynchronous queries).

type Proto = Record<string, unknown>;

const record = (sql: string, op: string, started: number, rows?: number, error?: string, store = als.getStore(), deferred?: boolean) => {
  if (!store) return;
  store.rec.sql.push({ sql: redactSql(sql), op, deferred: deferred || undefined, caller: runtime.current(), at: started, durationMs: Math.round((now() - started) * 100) / 100, rows, error });
};

/** Wrap a synchronous statement method; only active inside a traced request. */
function wrapSync(proto: Proto, method: string, sqlOf: (self: unknown, args: unknown[]) => string, rowsOf: (r: unknown) => number | undefined) {
  const orig = proto[method] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof orig !== 'function' || (orig as { __tn?: boolean }).__tn) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!als.getStore()) return orig.apply(this, args);
    const started = now();
    try {
      const result = orig.apply(this, args);
      record(sqlOf(this, args), method, started, rowsOf(result));
      return result;
    } catch (err) {
      record(sqlOf(this, args), method, started, undefined, safeError(err));
      throw err;
    }
  };
  (wrapped as { __tn?: boolean }).__tn = true;
  proto[method] = wrapped;
}

const rowsOfRun = (r: unknown) => (r as { changes?: number })?.changes;
const rowsOfGet = (r: unknown) => (r ? 1 : 0);
const rowsOfAll = (r: unknown) => (Array.isArray(r) ? r.length : undefined);

const patchedDrivers = new Set<string>();
const DRIVERS: Record<string, (mod: unknown) => void> = {
  'better-sqlite3': patchBetterSqlite,
  pg: patchPg,
};

/** better-sqlite3: `db.prepare(sql)` returns a Statement whose `.source` is the SQL text. */
function patchBetterSqlite(mod: unknown) {
  const Database = mod as { prototype?: Proto };
  const proto = Database?.prototype;
  if (!proto || typeof proto.prepare !== 'function') return;
  const prepare = proto.prepare as (...a: unknown[]) => unknown;
  let stmtPatched = false;
  proto.prepare = function (this: unknown, ...args: unknown[]) {
    const stmt = prepare.apply(this, args);
    if (!stmtPatched && stmt && typeof stmt === 'object') {
      stmtPatched = true;
      const sp = Object.getPrototypeOf(stmt) as Proto;
      const sqlOf = (self: unknown) => String((self as { source?: string }).source ?? '?');
      wrapSync(sp, 'run', sqlOf, rowsOfRun);
      wrapSync(sp, 'get', sqlOf, rowsOfGet);
      wrapSync(sp, 'all', sqlOf, rowsOfAll);
      wrapSync(sp, 'iterate', sqlOf, () => undefined);
    }
    return stmt;
  };
  wrapSync(proto, 'exec', (_s, a) => String(a[0]), () => undefined);
  log('observing better-sqlite3 statements (SQL text only)');
}

/** pg: `client.query(text | { text }, values?, callback?)`; a Pool's queries go through its clients. */
function patchPg(mod: unknown) {
  const Client = (mod as { Client?: { prototype?: Proto } })?.Client;
  const proto = Client?.prototype;
  const orig = proto?.query as ((...a: unknown[]) => unknown) | undefined;
  if (!proto || typeof orig !== 'function') return;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const stream = (this as { connection?: { stream?: { __tnApi?: boolean } } }).connection?.stream;
    if (stream) stream.__tnApi = true; // the wire observer leaves this connection to us
    const store = als.getStore();
    if (!store) return orig.apply(this, args);
    const q = args[0];
    const sql = typeof q === 'string' ? q : String((q as { text?: string })?.text ?? '?');
    const fromPool = poolTexts.get(sql);
    if (fromPool) {
      if (fromPool === 1) poolTexts.delete(sql);
      else poolTexts.set(sql, fromPool - 1);
      return orig.apply(this, args);
    }
    const started = now();
    // Called with none of the request's code on the stack (e.g. from a pool's queue, which can
    // run in another request's context): only likely to belong to this request.
    const deferred = store.ctx.stack.length === 0;
    const done = (err: unknown, res: unknown) =>
      record(sql, 'query', started, err ? undefined : ((res as { rowCount?: number | null })?.rowCount ?? undefined), err ? safeError(err) : undefined, store, deferred);
    const cbAt = args.findIndex((a) => typeof a === 'function');
    if (cbAt >= 0) {
      const cb = args[cbAt] as (e: unknown, r: unknown) => void;
      args[cbAt] = (e: unknown, r: unknown) => {
        done(e, r);
        cb(e, r);
      };
      return orig.apply(this, args);
    }
    const result = orig.apply(this, args);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(
        (r) => done(undefined, r),
        (e) => done(e, undefined),
      );
    }
    return result;
  };
  // pool.query() is called by the request's own code, then runs client.query() later, once
  // the pool hands out a connection (possibly from another request's context). Recording at
  // pool.query() keeps the exact caller; the later client.query() is then not recorded again.
  const Pool = (mod as { Pool?: { prototype?: Proto } })?.Pool;
  const poolProto = Pool?.prototype;
  const poolQuery = poolProto?.query as ((...a: unknown[]) => unknown) | undefined;
  if (poolProto && typeof poolQuery === 'function') {
    poolProto.query = function (this: unknown, ...args: unknown[]) {
      const store = als.getStore();
      const q = args[0];
      if (!store || (typeof q !== 'string' && typeof (q as { text?: unknown })?.text !== 'string')) return poolQuery.apply(this, args);
      const sql = typeof q === 'string' ? q : (q as { text: string }).text;
      const started = now();
      const caller = runtime.current();
      const deferred = store.ctx.stack.length === 0;
      poolTexts.set(sql, (poolTexts.get(sql) ?? 0) + 1);
      const done = (err: unknown, res: unknown) => {
        store.rec.sql.push({
          sql: redactSql(sql),
          op: 'query',
          caller,
          at: started,
          durationMs: Math.round((now() - started) * 100) / 100,
          rows: err ? undefined : ((res as { rowCount?: number | null })?.rowCount ?? undefined),
          error: err ? safeError(err) : undefined,
          deferred: deferred || undefined,
        });
      };
      const cbAt = args.findIndex((x) => typeof x === 'function');
      if (cbAt >= 0) {
        const cb = args[cbAt] as (e: unknown, r: unknown) => void;
        args[cbAt] = (e: unknown, r: unknown) => {
          done(e, r);
          cb(e, r);
        };
        return poolQuery.apply(this, args);
      }
      const result = poolQuery.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then((r) => done(undefined, r), (e) => done(e, undefined));
      return result;
    };
  }
  log('observing pg queries (SQL text only)');
}

/** SQL texts handed to pool.query() and not yet run by a client (recorded there instead). */
const poolTexts = new Map<string, number>();

/** A driver error message without the quoted parts, which often contain values. */
function safeError(err: unknown) {
  return String((err as Error)?.message ?? err)
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, 200);
}

// Which async operation scheduled which (timers, immediates, promises…), recorded only while
// a trace is armed. It tells whether a database write was set off by the connection itself
// (a driver flushing its queue when the server is ready) rather than by request code.
const scheduledBy = new Map<number, number>();
const asyncTrail = createHook({
  init(id, _type, trigger) {
    if (scheduledBy.size > 200_000) scheduledBy.clear();
    scheduledBy.set(id, trigger);
  },
});

/** True when the current code was set off, directly or through timers/promises, by this socket's own events. */
function inSocketCallback(socket: object) {
  const sock = (socket as { _handle?: { getAsyncId?: () => number } })._handle?.getAsyncId?.();
  if (sock === undefined) return false;
  let id: number | undefined = executionAsyncId();
  for (let hops = 0; id && hops < 16; hops++) {
    if (id === sock) return true;
    id = scheduledBy.get(id);
  }
  return false;
}

// Any other in-process database client: read statements from the wire protocol itself.
observeDatabaseSockets({
  now,
  onStatement(socket, st) {
    // Statements already recorded at the driver API (pg) are not recorded twice.
    if (!active || (socket as { __tnApi?: boolean }).__tnApi) return undefined;
    // Written from the connection's own callback (a queued statement sent when the server
    // became ready): the async context there belongs to whoever opened the connection, not to
    // the request that queued it. Such statements are kept, but linked to no request.
    const fromConnection = inSocketCallback(socket);
    const store = fromConnection ? undefined : als.getStore();
    if (DEBUG) log(`wire ${st.protocol} ${st.text.slice(0, 60)} | store=${store ? store.rec.key : '-'} stack=${store?.ctx.stack.length ?? '-'} fromConnection=${fromConnection}`);
    // Outside any traced request and not from a connection's queue: unrelated work (a timer,
    // another visitor's request). It is not part of this recording.
    if (!store && !fromConnection) return undefined;
    const rec: AgentSqlRecord = { sql: st.text, op: st.op, caller: store ? runtime.current() : 0, at: st.started, protocol: st.protocol };
    if (!store) {
      rec.queued = true;
      if (inFlight.untraced > 0) rec.busy = true;
      if (active.unattributed.length < 200) active.unattributed.push(rec);
    } else {
      // Sent while the request's own code is on the stack: this request sent it. Sent from the
      // driver's queue or a timer: probably this request, but batching could mix requests.
      if (store.ctx.stack.length === 0) rec.deferred = true;
      store.rec.sql.push(rec);
    }
    return (rows, error) => {
      rec.durationMs = Math.round((now() - st.started) * 100) / 100;
      if (rows !== undefined) rec.rows = rows;
      if (error) rec.error = error;
    };
  },
});

// --- 3b. Requests the server makes to other services ------------------------------------
//   Recorded for traced requests; local services (localhost) also receive the trace header,
//   so their agent can report their side too. Other hosts never receive it.

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;
const outgoing = new WeakMap<object, AgentOutgoingRecord>();

function startOutgoing(method: string, url: URL, setHeader: (name: string, value: string) => void) {
  const store = als.getStore();
  if (!store || !active) return undefined;
  const list = (store.rec.outgoing ??= []);
  const local = LOCAL_HOST.test(url.hostname);
  const rec: AgentOutgoingRecord = { method: method.toUpperCase(), url: redactQuery(url.origin + url.pathname + url.search), caller: runtime.current(), at: now() };
  if (local && ownPorts.has(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) rec.self = true;
  if (local) {
    rec.key = `${store.rec.key ?? store.rec.seq}.${list.length + 1}`;
    setHeader('x-tracenaut-trace', `${active.traceId}:${rec.key}`);
  }
  if (DEBUG) log(`outgoing ${rec.method} ${rec.url} key=${rec.key ?? '-'}`);
  list.push(rec);
  return rec;
}
const finishOutgoing = (rec: AgentOutgoingRecord | undefined, status?: number, error?: string) => {
  if (!rec || rec.durationMs !== undefined) return;
  rec.durationMs = Math.round((now() - rec.at) * 10) / 10;
  if (status) rec.status = status;
  if (error) rec.error = error;
};

diagnostics.subscribe('http.client.request.created', (msg) => {
  const req = (msg as { request: http.ClientRequest }).request;
  try {
    const url = new URL(`${(req as unknown as { protocol?: string }).protocol ?? 'http:'}//${req.host}${req.path}`);
    const rec = startOutgoing(req.method, url, (n, v) => req.setHeader(n, v));
    if (rec) {
      outgoing.set(req, rec);
      req.once('error', (err) => finishOutgoing(rec, undefined, err.message));
    }
  } catch {
    // never interfere with the app's request
  }
});
diagnostics.subscribe('http.client.response.finish', (msg) => {
  const { request, response } = msg as { request: object; response: http.IncomingMessage };
  finishOutgoing(outgoing.get(request), response.statusCode);
});
// fetch() in Node (undici)
diagnostics.subscribe('undici:request:create', (msg) => {
  const req = (msg as { request: { method: string; origin: string; path: string; addHeader(n: string, v: string): void } }).request;
  try {
    const rec = startOutgoing(req.method, new URL(req.path, req.origin), (n, v) => req.addHeader(n, v));
    if (rec) outgoing.set(req, rec);
  } catch {
    // ignore
  }
});
diagnostics.subscribe('undici:request:headers', (msg) => {
  const { request, response } = msg as { request: object; response: { statusCode: number } };
  finishOutgoing(outgoing.get(request), response.statusCode);
});
diagnostics.subscribe('undici:request:error', (msg) => {
  const { request, error } = msg as { request: object; error: Error };
  finishOutgoing(outgoing.get(request), undefined, error.message);
});

let sqlitePatched = false;
function patchSqlite() {
  if (sqlitePatched) return;
  sqlitePatched = true;
  const require = createRequire(import.meta.url);
  const sqlite = require('node:sqlite');
  const wrap = wrapSync;
  const stmtProto = sqlite.StatementSync?.prototype;
  if (stmtProto) {
    const sqlOf = (self: unknown) => String((self as { sourceSQL?: string }).sourceSQL ?? '?');
    wrap(stmtProto, 'run', sqlOf, rowsOfRun);
    wrap(stmtProto, 'get', sqlOf, rowsOfGet);
    wrap(stmtProto, 'all', sqlOf, rowsOfAll);
    wrap(stmtProto, 'iterate', sqlOf, () => undefined);
  }
  if (sqlite.DatabaseSync?.prototype) wrap(sqlite.DatabaseSync.prototype, 'exec', (_s, a) => String(a[0]), () => undefined);
}

// --- 4. Talk to the daemon (only once this process actually serves HTTP) ---------------

let connecting = false;
const origListen = http.Server.prototype.listen;
/** Ports this process listens on (a request to one of them is the server calling itself). */
const ownPorts = new Set<number>();

http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (!connecting) {
    connecting = true;
    connect();
  }
  this.once('listening', () => {
    const addr = this.address();
    if (addr && typeof addr === 'object') ownPorts.add(addr.port);
  });
  return (origListen as (...a: unknown[]) => http.Server).apply(this, args);
} as typeof http.Server.prototype.listen;

function connect() {
  const session = readSession();
  if (!session) {
    retry('no daemon session found');
    return;
  }
  const socket = new WebSocket(`ws://127.0.0.1:${session.port}/agent?token=${session.token}`);
  let welcomed = false;
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', pid: process.pid, cwd: process.cwd(), entry: process.argv[1], service: process.env.TRACENAUT_SERVICE }));
  });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'welcome') {
      welcomed = true;
      log(`connected to TraceNaut as service "${msg.service}"`);
    } else if (msg.type === 'reject') {
      log(`daemon rejected this process: ${msg.reason}`);
    } else if (msg.type === 'start') {
      active = { traceId: msg.traceId, requests: [], unattributed: [] };
      asyncTrail.enable();
      socket.send(JSON.stringify({ type: 'started', traceId: msg.traceId }));
    } else if (msg.type === 'stop') {
      const current = active;
      const mine = current && current.traceId === msg.traceId ? current : undefined;
      if (mine) {
        active = null;
        asyncTrail.disable();
        scheduledBy.clear();
      }
      socket.send(JSON.stringify({ type: 'result', traceId: msg.traceId, requests: mine?.requests ?? [], unattributed: mine?.unattributed ?? [] }));
    }
  });
  socket.addEventListener('close', () => {
    active = null;
    asyncTrail.disable();
    scheduledBy.clear();
    retry(welcomed ? 'connection to daemon closed' : 'daemon not reachable');
  });
  socket.addEventListener('error', () => {
    // 'close' follows and schedules the retry.
  });
}

let lastReason = '';
function retry(reason: string) {
  if (reason !== lastReason) log(`${reason}; retrying in the background`);
  lastReason = reason;
  setTimeout(connect, 3000).unref();
}
