import net from 'node:net';

/**
 * Database statements observed on the wire, for any driver or ORM that talks to the server
 * from this process (pg, postgres.js, Drizzle, Knex, Sequelize, TypeORM, mysql2, mongodb,
 * Mongoose, redis, ioredis…). Instead of patching each library, outgoing socket writes are
 * read as the database protocol they carry:
 *
 *   PostgreSQL  Query ('Q') and Parse ('P') messages carry SQL text; Execute ('E') runs it.
 *   MySQL       COM_QUERY / COM_STMT_PREPARE packets carry SQL text.
 *   MongoDB     OP_MSG: the first field of the command document names the command and
 *               the collection ({ find: 'users', … }); nothing else is read.
 *   Redis       RESP arrays: only the command name (GET, SET…) is kept, never keys.
 *
 * What is never read: bind parameters, password messages, documents, keys, values. String
 * literals inside SQL text are replaced by '…' before anything is recorded. Server replies
 * are watched only for PostgreSQL (row counts and error codes), by observing `data` events
 * without adding a listener, so the driver's stream mode is never changed.
 */

export type Protocol = 'postgres' | 'mysql' | 'mongodb' | 'redis';

export interface WireStatement {
  protocol: Protocol;
  /** SQL text (literals redacted), or `find users` / `GET` for MongoDB and Redis. */
  text: string;
  op: string;
  started: number;
  /** Filled in when the server answers (PostgreSQL only). */
  done?: (rows: number | undefined, error: string | undefined) => void;
}

interface Hooks {
  /** Called for each statement sent; returns a completion callback if it was recorded. */
  onStatement(socket: net.Socket, s: Omit<WireStatement, 'done'>): WireStatement['done'] | undefined;
  now(): number;
}

const MAX_BUFFER = 1 << 20; // a message bigger than this (bulk data) is skipped, not buffered

interface PgState {
  kind: 'postgres';
  out: Buffer;
  started: boolean;
  named: Map<string, string>;
  unnamed?: string;
  portal?: string;
  /**
   * Statements sent and not yet settled, in order. A batch ends with Sync (extended protocol)
   * or with each simple Query; the server answers each batch with one ReadyForQuery.
   */
  pending: { simple: boolean; batch: number; answered: boolean; done?: WireStatement['done'] }[];
  batch: number;
  in: Buffer;
}
interface FramedState {
  kind: 'mysql' | 'mongodb' | 'redis';
  out: Buffer;
}
type State = PgState | FramedState | { kind: 'other' };

const states = new WeakMap<net.Socket, State>();

/** Replace '…' string literals (and $$…$$ bodies) in SQL with '…' so values never leave the process. */
export function redactSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "'…'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cstring(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at);
  if (end < 0) return ['', buf.length];
  return [buf.toString('utf8', at, end), end + 1];
}

function sqlOp(sql: string) {
  return (/^\s*(\w+)/.exec(sql)?.[1] ?? 'sql').toUpperCase();
}

function identify(chunk: Buffer): State['kind'] {
  if (chunk.length >= 8) {
    const len = chunk.readInt32BE(0);
    const code = chunk.readInt32BE(4);
    // StartupMessage (protocol 3.0), SSLRequest, GSSENCRequest, CancelRequest
    if ((code === 196608 || code === 80877103 || code === 80877104 || code === 80877102) && len >= 8 && len <= 10_000) return 'postgres';
  }
  if (chunk.length >= 16) {
    const len = chunk.readInt32LE(0);
    const opCode = chunk.readInt32LE(12);
    if ((opCode === 2013 || opCode === 2004) && len >= 16 && len <= 48_000_000) return 'mongodb';
  }
  if (chunk.length >= 4 && chunk[0] === 0x2a /* * */ && /^\*\d+\r\n\$/.test(chunk.toString('latin1', 0, Math.min(16, chunk.length)))) return 'redis';
  // MySQL: the client's first packet is the handshake response (sequence id 1): capability
  // flags with CLIENT_PROTOCOL_41, max packet size, charset, then 23 reserved zero bytes.
  if (chunk.length >= 36 && chunk.readUIntLE(0, 3) + 4 <= chunk.length && chunk[3] === 1) {
    const caps = chunk.readUInt32LE(4);
    if (caps & 0x200 && chunk.subarray(13, 36).every((b) => b === 0)) return 'mysql';
  }
  return 'other';
}

export function observeDatabaseSockets(hooks: Hooks) {
  const proto = net.Socket.prototype as unknown as { write: (...a: unknown[]) => boolean; __tnWire?: boolean };
  if (proto.__tnWire) return;
  proto.__tnWire = true;
  const write = proto.write;
  proto.write = function (this: net.Socket, ...args: unknown[]) {
    try {
      const [chunk, enc] = args;
      if (chunk !== undefined && chunk !== null && !(this as { __tnSkip?: boolean }).__tnSkip) {
        const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : typeof chunk === 'string' ? Buffer.from(chunk, (typeof enc === 'string' ? enc : 'utf8') as BufferEncoding) : undefined;
        if (buf && buf.length) onWrite(this, buf);
      }
    } catch {
      // Observation must never break the application's connection.
      states.set(this, { kind: 'other' });
    }
    return write.apply(this, args);
  };

  function onWrite(socket: net.Socket, buf: Buffer) {
    let st = states.get(socket);
    if (!st) {
      const kind = identify(buf);
      st = kind === 'postgres' ? newPg(socket) : kind === 'other' ? { kind } : { kind, out: Buffer.alloc(0) };
      states.set(socket, st);
    }
    if (st.kind === 'other') return;
    st.out = st.out.length ? Buffer.concat([st.out, buf]) : buf;
    if (st.out.length > MAX_BUFFER) {
      st.out = Buffer.alloc(0); // give up on this oversized message; resync on the next one
      return;
    }
    if (st.kind === 'postgres') pgOut(socket, st);
    else if (st.kind === 'mysql') mysqlOut(socket, st);
    else if (st.kind === 'mongodb') mongoOut(socket, st);
    else redisOut(socket, st);
  }

  // ------------------------------------------------------------------ PostgreSQL

  function newPg(socket: net.Socket): PgState {
    const st: PgState = { kind: 'postgres', out: Buffer.alloc(0), started: false, named: new Map(), pending: [], batch: 0, in: Buffer.alloc(0) };
    // Watch replies by wrapping this socket's emit: no listener is added, so the stream's
    // mode (flowing or paused) is exactly what the driver chose.
    const emit = socket.emit;
    socket.emit = function (this: net.Socket, event: string | symbol, ...a: unknown[]) {
      if (event === 'data' && Buffer.isBuffer(a[0])) {
        try {
          pgIn(st, a[0]);
        } catch {
          st.pending = [];
        }
      }
      return (emit as (...x: unknown[]) => boolean).call(this, event, ...a);
    } as typeof socket.emit;
    return st;
  }

  function pgOut(socket: net.Socket, st: PgState) {
    let buf = st.out;
    while (!st.started) {
      if (buf.length < 8) {
        st.out = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
        return;
      }
      const len = buf.readInt32BE(0);
      if (len < 8 || buf.length < len) {
        st.out = Buffer.from(buf);
        return;
      }
      const code = buf.readInt32BE(4);
      buf = buf.subarray(len);
      // SSLRequest / GSSENCRequest: if the server accepts, the conversation moves to a TLS
      // socket (a new object; this one then carries no more JS writes). If it refuses, the
      // StartupMessage follows on this same socket, so keep waiting for it.
      if (code === 80877103 || code === 80877104) continue;
      st.started = true;
    }
    while (buf.length >= 5) {
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (len < 4 || buf.length < len + 1) break;
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      if (type === 'Q') {
        const [sql] = cstring(body, 0);
        statement(socket, st, sql, true);
      } else if (type === 'P') {
        const [name, at] = cstring(body, 0);
        const [sql] = cstring(body, at);
        if (name) st.named.set(name, sql);
        else st.unnamed = sql;
      } else if (type === 'B') {
        // Bind: only the statement name is read; parameter values are skipped.
        const [, at] = cstring(body, 0);
        const [stmt] = cstring(body, at);
        st.portal = stmt ? st.named.get(stmt) : st.unnamed;
      } else if (type === 'E') {
        if (st.portal) statement(socket, st, st.portal, false);
      } else if (type === 'S') {
        st.batch++;
      } else if (type === 'C' && body[0] === 0x53 /* S: close statement */) {
        const [name] = cstring(body, 1);
        st.named.delete(name);
      }
      // 'p' (password), 'd' (copy data), 'F' (function call) and others are not read.
    }
    st.out = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

  function statement(socket: net.Socket, st: PgState, sql: string, simple: boolean) {
    const text = redactSql(sql);
    const done = text ? hooks.onStatement(socket, { protocol: 'postgres', text, op: sqlOp(text), started: hooks.now() }) : undefined;
    st.pending.push({ simple, batch: st.batch, answered: false, done });
    // Replies are invisible if the driver reads the socket without 'data' events; never let
    // the queue grow without bound in that case.
    if (st.pending.length > 256) st.pending.splice(0, st.pending.length - 256);
    if (simple) st.batch++; // a simple Query is its own batch
  }

  /** The statement a CommandComplete / ErrorResponse belongs to, if it should be reported. */
  function answerTarget(st: PgState) {
    const oldest = st.pending[0];
    if (!oldest) return undefined;
    // A simple query may contain several statements; only its first result is reported.
    if (oldest.simple) return oldest.answered ? undefined : oldest;
    return st.pending.find((p) => !p.answered && p.batch === oldest.batch);
  }

  function pgIn(st: PgState, chunk: Buffer) {
    if (!st.started) return;
    let buf = st.in.length ? Buffer.concat([st.in, chunk]) : chunk;
    while (buf.length >= 5) {
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (len < 4) {
        buf = Buffer.alloc(0);
        break;
      }
      if (buf.length < len + 1) break;
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      if (type === 's') {
        // PortalSuspended: the statement returned some rows and paused (fetching in chunks).
        const target = answerTarget(st);
        if (target) {
          target.answered = true;
          target.done?.(undefined, undefined);
        }
      } else if (type === 'C' || type === 'I' || type === 'E') {
        const target = answerTarget(st);
        if (target) {
          target.answered = true;
          if (type === 'E') target.done?.(undefined, pgError(body));
          else {
            const n = type === 'C' ? /(\d+)$/.exec(cstring(body, 0)[0])?.[1] : undefined;
            target.done?.(n !== undefined ? Number(n) : undefined, undefined);
          }
        }
      } else if (type === 'Z') {
        // ReadyForQuery ends the oldest batch. Its statements still unanswered were skipped
        // by the server after an error earlier in the same batch.
        const batch = st.pending[0]?.batch;
        while (st.pending.length && st.pending[0].batch === batch) {
          const p = st.pending.shift()!;
          if (!p.answered) p.done?.(undefined, 'not run: an earlier statement in the same batch failed');
        }
      }
    }
    if (buf.length > MAX_BUFFER) buf = Buffer.alloc(0);
    st.in = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

  /** SQLSTATE code and message; quoted parts of the message (often values) are removed. */
  function pgError(body: Buffer) {
    let code = '';
    let message = '';
    for (let at = 0; at < body.length && body[at] !== 0; ) {
      const field = String.fromCharCode(body[at]);
      const [value, next] = cstring(body, at + 1);
      if (field === 'C') code = value;
      if (field === 'M') message = value;
      at = next;
    }
    const safe = message.replace(/"[^"]*"/g, '"…"').replace(/\([^)]*\)=\([^)]*\)/g, '(…)=(…)');
    return `${safe}${code ? ` (SQLSTATE ${code})` : ''}`;
  }

  // ------------------------------------------------------------------ MySQL

  function mysqlOut(socket: net.Socket, st: FramedState) {
    let buf = st.out;
    while (buf.length >= 4) {
      const len = buf.readUIntLE(0, 3);
      if (buf.length < len + 4) break;
      const payload = buf.subarray(4, len + 4);
      buf = buf.subarray(len + 4);
      const cmd = payload[0];
      if ((cmd === 0x03 || cmd === 0x16) && payload.length > 1) {
        // COM_QUERY / COM_STMT_PREPARE. (Prepared statements are reported when prepared.)
        const text = redactSql(payload.toString('utf8', 1));
        if (text) hooks.onStatement(socket, { protocol: 'mysql', text, op: sqlOp(text), started: hooks.now() });
      }
    }
    st.out = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

  // ------------------------------------------------------------------ MongoDB

  function mongoOut(socket: net.Socket, st: FramedState) {
    let buf = st.out;
    while (buf.length >= 16) {
      const len = buf.readInt32LE(0);
      if (len < 16 || buf.length < len) break;
      const msg = buf.subarray(0, len);
      buf = buf.subarray(len);
      if (msg.readInt32LE(12) !== 2013) continue; // OP_MSG only
      // flagBits (4) then section 0: kind byte 0 + BSON document
      let at = 20;
      if (msg[at] !== 0) continue;
      at += 1;
      const docLen = msg.readInt32LE(at);
      if (docLen < 5 || at + docLen > msg.length) continue;
      const type = msg[at + 4];
      const [command, next] = cstring(msg, at + 5);
      let collection = '';
      if (type === 0x02) collection = msg.toString('utf8', next + 4, next + 4 + Math.max(0, msg.readInt32LE(next) - 1));
      if (!command || /^(hello|ismaster|isMaster|ping|saslStart|saslContinue|endSessions|buildInfo|getMore|killCursors)$/.test(command)) continue;
      hooks.onStatement(socket, { protocol: 'mongodb', text: collection ? `${command} ${collection}` : command, op: command, started: hooks.now() });
    }
    st.out = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

  // ------------------------------------------------------------------ Redis

  function redisOut(socket: net.Socket, st: FramedState) {
    // Commands are RESP arrays: *<n>\r\n then n bulk strings $<len>\r\n<bytes>\r\n. Only the
    // first (the command name) is read; the others are skipped by their length, so a value can
    // never be mistaken for a command.
    let buf = st.out;
    const line = (at: number) => {
      const end = buf.indexOf('\r\n', at, 'latin1');
      return end < 0 ? undefined : { text: buf.toString('latin1', at, end), next: end + 2 };
    };
    let at = 0;
    for (;;) {
      if (at >= buf.length) break;
      if (buf[at] !== 0x2a /* * */) {
        at = buf.length; // not a command array (inline command or out of sync): drop it
        break;
      }
      const head = line(at);
      if (!head) break;
      const n = Number(head.text.slice(1));
      let pos = head.next;
      let name: string | undefined;
      let complete = true;
      for (let i = 0; i < n; i++) {
        const bulk = line(pos);
        if (!bulk || bulk.text[0] !== '$') {
          complete = false;
          break;
        }
        const len = Number(bulk.text.slice(1));
        if (bulk.next + len + 2 > buf.length) {
          complete = false;
          break;
        }
        if (i === 0) name = buf.toString('latin1', bulk.next, bulk.next + len).toUpperCase();
        pos = bulk.next + len + 2;
      }
      if (!complete) break;
      if (name && /^[A-Z.]+$/.test(name) && !/^(AUTH|HELLO|PING|SELECT|CLIENT|INFO)$/.test(name)) hooks.onStatement(socket, { protocol: 'redis', text: name, op: name, started: hooks.now() });
      at = pos;
    }
    buf = buf.subarray(at);
    st.out = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

}
