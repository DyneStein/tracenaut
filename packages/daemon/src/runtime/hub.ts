import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { AgentRequestRecord, FrontendTracePayload, TraceResult } from '@tracenaut/protocol';
import type { Analyzer } from '../analysis/analyzer.js';
import { type Workspace, serviceForFile, toRel } from '../workspace.js';
import { buildTrace, type AgentResult } from './merge.js';

interface AgentConn {
  socket: WebSocket;
  service: string;
  pid: number;
  pending: Map<string, (msg: AgentMessage) => void>;
}

type AgentMessage =
  | { type: 'hello'; pid: number; cwd: string; entry?: string; service?: string }
  | { type: 'started'; traceId: string }
  | { type: 'result'; traceId: string; requests: AgentRequestRecord[] };

interface ActiveTrace {
  id: string;
  startedAt: number;
}

const ACK_TIMEOUT_MS = 1500;

/** Coordinates runtime agents and the trace lifecycle. */
export class RuntimeHub {
  private agents = new Set<AgentConn>();
  private traces = new Map<string, ActiveTrace>();

  constructor(
    private ws: Workspace,
    private analyzer: Analyzer,
  ) {}

  attach(socket: WebSocket) {
    let conn: AgentConn | undefined;
    socket.on('message', (raw) => {
      let msg: AgentMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        const service = this.serviceFor(msg);
        if (!service) {
          socket.send(JSON.stringify({ type: 'reject', reason: `No node service in ${this.ws.repoRoot} contains ${msg.entry ?? msg.cwd}` }));
          socket.close();
          return;
        }
        conn = { socket, service, pid: msg.pid, pending: new Map() };
        this.agents.add(conn);
        socket.send(JSON.stringify({ type: 'welcome', service, repoRoot: this.ws.repoRoot }));
        console.log(`[tracenaut] agent connected: ${service} (pid ${msg.pid})`);
        return;
      }
      if (!conn) return;
      const key = `${msg.type}:${msg.traceId}`;
      conn.pending.get(key)?.(msg);
      conn.pending.delete(key);
    });
    socket.on('close', () => {
      if (conn) {
        this.agents.delete(conn);
        console.log(`[tracenaut] agent disconnected: ${conn.service} (pid ${conn.pid})`);
      }
    });
  }

  private serviceFor(msg: Extract<AgentMessage, { type: 'hello' }>) {
    if (msg.service && this.ws.services.some((s) => s.name === msg.service)) return msg.service;
    for (const candidate of [msg.entry, msg.cwd]) {
      if (!candidate) continue;
      const abs = path.resolve(msg.cwd, candidate);
      if (!abs.startsWith(this.ws.repoRoot)) continue;
      const svc = serviceForFile(this.ws, toRel(this.ws, abs));
      if (svc?.kind === 'node') return svc.name;
    }
    return undefined;
  }

  agentList() {
    return [...this.agents].map((a) => ({ service: a.service, pid: a.pid }));
  }

  private request<T extends AgentMessage>(conn: AgentConn, send: object, expect: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(expect);
        resolve(undefined);
      }, ACK_TIMEOUT_MS);
      conn.pending.set(expect, (msg) => {
        clearTimeout(timer);
        resolve(msg as T);
      });
      conn.socket.send(JSON.stringify(send));
    });
  }

  async start() {
    const id = randomBytes(6).toString('hex');
    this.traces.set(id, { id, startedAt: Date.now() });
    await Promise.all([...this.agents].map((a) => this.request(a, { type: 'start', traceId: id }, `started:${id}`)));
    // Traces that are never finished are discarded after a minute.
    setTimeout(() => this.traces.delete(id), 60_000).unref();
    return { traceId: id, agents: this.connectedStatus() };
  }

  private connectedStatus() {
    return this.ws.services
      .filter((s) => s.kind === 'node')
      .map((s) => ({ service: s.name, connected: [...this.agents].some((a) => a.service === s.name) }));
  }

  async finish(id: string, payload: FrontendTracePayload): Promise<TraceResult> {
    if (!this.traces.has(id)) throw new Error('Unknown or expired trace');
    this.traces.delete(id);
    const results = await Promise.all(
      [...this.agents].map(async (a) => {
        const msg = await this.request<Extract<AgentMessage, { type: 'result' }>>(a, { type: 'stop', traceId: id }, `result:${id}`);
        return msg ? ({ service: a.service, requests: msg.requests } satisfies AgentResult) : undefined;
      }),
    );
    return buildTrace(this.analyzer, id, payload, results.filter((r): r is AgentResult => !!r), this.connectedStatus());
  }
}
