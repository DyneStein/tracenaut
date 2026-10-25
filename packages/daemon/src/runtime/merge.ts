import type {
  AgentRequestRecord,
  AgentSqlRecord,
  ClientRequestRecord,
  FrontendTracePayload,
  GraphNode,
  ProbeCallWire,
  TraceCall,
  TraceRequest,
  TraceResult,
} from '@tracenaut/protocol';
import type { Analyzer } from '../analysis/analyzer.js';
import { parseLoc } from '../analysis/ids.js';
import { serviceForFile } from '../workspace.js';

export interface AgentResult {
  service: string;
  requests: AgentRequestRecord[];
}

function parseProbe(id: string) {
  const [file, line, col, kind, ...rest] = id.split('|');
  return { file, line: Number(line), col: Number(col), kind, name: rest.join('|') };
}

/**
 * Turn raw probe events into call trees. Everything here is observed: a child
 * appears under a parent only because it started while the parent was on the stack.
 */
function buildTree(
  analyzer: Analyzer,
  calls: ProbeCallWire[],
  nodeCache: Map<string, GraphNode>,
  opts: { splitRenders: boolean },
) {
  const nodeFor = (probe: string) => {
    let n = nodeCache.get(probe);
    if (!n) {
      const p = parseProbe(probe);
      n = analyzer.probeNode(p.file, p.line, p.col, p.name, p.kind);
      nodeCache.set(probe, n);
    }
    return n;
  };
  const byToken = new Map<number, TraceCall>();
  const roots: TraceCall[] = [];
  const renders = new Map<string, { node: GraphNode; count: number }>();
  const inRender = new Set<number>();

  for (const c of calls) {
    const p = parseProbe(c.id);
    // Component renders started by the framework (not by user code) are summarised,
    // together with everything they call, instead of cluttering the causal tree.
    if (opts.splitRenders && (inRender.has(c.parent) || (p.kind === 'c' && !byToken.has(c.parent)))) {
      inRender.add(c.t);
      if (p.kind === 'c') {
        const node = nodeFor(c.id);
        const r = renders.get(node.id) ?? { node, count: 0 };
        r.count++;
        renders.set(node.id, r);
      }
      continue;
    }
    const call: TraceCall = {
      node: nodeFor(c.id),
      probe: c.id,
      at: c.at,
      byEvent: c.parent === 0 ? c.ev === true : undefined,
      durationMs: c.end !== undefined ? round(c.end - c.at) : undefined,
      children: [],
      requests: [],
      sql: [],
    };
    byToken.set(c.t, call);
    const parent = byToken.get(c.parent);
    if (parent) parent.children.push(call);
    else roots.push(call);
  }
  return { roots, byToken, renders: [...renders.values()], inRender };
}

const round = (n: number) => Math.round(n * 10) / 10;

export function buildTrace(
  analyzer: Analyzer,
  id: string,
  frontend: FrontendTracePayload,
  agents: AgentResult[],
  connected: { service: string; connected: boolean }[],
): TraceResult {
  const nodeCache = new Map<string, GraphNode>();
  const notes: string[] = [];
  const fe = buildTree(analyzer, frontend.calls, nodeCache, { splitRenders: true });

  const serverBySeq = new Map<number, { service: string; rec: AgentRequestRecord }>();
  for (const a of agents) for (const rec of a.requests) serverBySeq.set(rec.seq, { service: a.service, rec });

  const orphanRequests: TraceRequest[] = [];
  for (const r of frontend.requests) {
    const tr = traceRequest(analyzer, r, serverBySeq, nodeCache, connected);
    const initiator = fe.byToken.get(r.initiator);
    if (initiator) initiator.requests.push(tr);
    else {
      if (r.initiator && fe.inRender.has(r.initiator)) tr.serverNote = [tr.serverNote, 'issued during a component render'].filter(Boolean).join('; ');
      orphanRequests.push(tr);
    }
  }

  if (!frontend.action) notes.push('No interaction happened while the trace was armed.');
  if (frontend.dropped) notes.push(`${frontend.dropped} function calls were not recorded because the per-trace limit was reached.`);
  if (frontend.requests.some((r) => !r.correlated)) {
    notes.push('Cross-origin requests are shown but not correlated with a backend (TraceNaut only adds its trace header to same-origin requests).');
  }
  const nodeServices = analyzer.ws.services.filter((s) => s.kind === 'node');
  for (const s of nodeServices) {
    if (!connected.find((c) => c.service === s.name && c.connected)) {
      notes.push(`No runtime agent is connected for "${s.name}", so its server-side execution was not observed. Start it with: node --import @tracenaut/node-agent <entry>.`);
    }
  }

  let action: TraceResult['action'];
  if (frontend.action) {
    action = { ...frontend.action };
    if (frontend.action.loc) {
      const { file, line, col } = parseLoc(frontend.action.loc);
      action.source = { service: serviceForFile(analyzer.ws, file)?.name ?? '?', file, line, col };
    }
  }

  return {
    id,
    action,
    durationMs: round(frontend.durationMs),
    calls: fe.roots,
    renders: fe.renders.sort((a, b) => b.count - a.count),
    orphanRequests,
    agents: connected,
    notes,
    eventMarks: frontend.eventMarks,
  };
}

function traceRequest(
  analyzer: Analyzer,
  r: ClientRequestRecord,
  serverBySeq: Map<number, { service: string; rec: AgentRequestRecord }>,
  nodeCache: Map<string, GraphNode>,
  connected: { service: string; connected: boolean }[],
): TraceRequest {
  const tr: TraceRequest = {
    at: r.at,
    method: r.method,
    url: r.url,
    status: r.status,
    durationMs: r.end !== undefined ? round(r.end - r.at) : undefined,
    error: r.error,
  };
  const server = serverBySeq.get(r.seq);
  if (!server) {
    tr.serverNote = !r.correlated
      ? 'cross-origin request; not correlated'
      : connected.some((c) => c.connected)
        ? 'no instrumented backend handled this request'
        : 'no backend agent connected';
    return tr;
  }
  const { service, rec } = server;
  const tree = buildTree(analyzer, rec.calls, nodeCache, { splitRenders: false });
  const topSql: AgentSqlRecord[] = [];
  for (const q of rec.sql) {
    const owner = tree.byToken.get(q.caller);
    if (owner) owner.sql.push({ ...q, evidence: 'runtime' });
    else topSql.push(q);
  }
  let routeNode: GraphNode | undefined;
  if (rec.route) {
    const [method, ...rest] = rec.route.split(' ');
    const route = analyzer.routeByRuntime(service, method, rest.join(' '));
    if (route) routeNode = analyzer.routeNode(route);
  }
  tr.server = { service, route: rec.route, routeNode, calls: tree.roots, sql: topSql, dropped: rec.dropped };
  return tr;
}
