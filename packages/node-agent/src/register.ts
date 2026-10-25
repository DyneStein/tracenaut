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
import { type AgentRequestRecord, redactQuery } from '@tracenaut/protocol';
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

let active: { traceId: string; requests: AgentRequestRecord[] } | null = null;

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
    if (!isInstrumentable(file) || !file.startsWith(scopeRoot + path.sep)) return result;
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
http.Server.prototype.emit = function (this: http.Server, event: string, ...args: unknown[]) {
  if (event === 'request' && active) {
    const [req, res] = args as [http.IncomingMessage & { route?: { path?: string }; baseUrl?: string }, http.ServerResponse];
    const header = req.headers['x-tracenaut-trace'];
    const [traceId, seq] = typeof header === 'string' ? header.split(':') : [];
    if (traceId === active.traceId) {
      const ctx = newProbeContext();
      const rec: AgentRequestRecord = { seq: Number(seq), method: req.method ?? 'GET', url: redactQuery(req.url ?? '/'), at: now(), calls: ctx.calls, sql: [], dropped: 0 };
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

const record = (sql: string, op: string, started: number, rows?: number, error?: string, store = als.getStore()) => {
  if (!store) return;
  store.rec.sql.push({ sql, op, caller: runtime.current(), at: started, durationMs: Math.round((now() - started) * 100) / 100, rows, error });
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
      record(sqlOf(this, args), method, started, undefined, (err as Error).message);
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
    const store = als.getStore();
    if (!store) return orig.apply(this, args);
    const q = args[0];
    const sql = typeof q === 'string' ? q : String((q as { text?: string })?.text ?? '?');
    const started = now();
    const done = (err: unknown, res: unknown) =>
      record(sql, 'query', started, err ? undefined : ((res as { rowCount?: number | null })?.rowCount ?? undefined), err ? (err as Error).message : undefined, store);
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
  log('observing pg queries (SQL text only)');
}

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
http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (!connecting) {
    connecting = true;
    connect();
  }
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
      active = { traceId: msg.traceId, requests: [] };
      socket.send(JSON.stringify({ type: 'started', traceId: msg.traceId }));
    } else if (msg.type === 'stop') {
      const current = active;
      const requests = current && current.traceId === msg.traceId ? current.requests : [];
      if (current && current.traceId === msg.traceId) active = null;
      socket.send(JSON.stringify({ type: 'result', traceId: msg.traceId, requests }));
    }
  });
  socket.addEventListener('close', () => {
    active = null;
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
