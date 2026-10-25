/**
 * Wire protocol shared by the daemon, the browser client and the agents.
 *
 * The central rule: every relationship carries its evidence. TraceNaut never
 * presents a statically possible relationship as something that happened.
 */

/**
 * - static:     derived from source analysis; describes what *can* happen.
 * - runtime:    observed during an actual execution.
 * - inferred:   a heuristic link (e.g. URL pattern ↔ route); plausible, not proven.
 * - unresolved: TraceNaut could not determine the target; the reason is in `note`.
 */
export type Evidence = 'static' | 'runtime' | 'inferred' | 'unresolved';

export interface SourceRef {
  service: string;
  /** Repo-relative POSIX path. */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  col?: number;
  endLine?: number;
  /** 0-based, present when the range is on a single line. */
  endCol?: number;
}

export type NodeKind =
  | 'element'
  | 'component'
  | 'function'
  | 'hook'
  | 'method'
  | 'class'
  | 'http-request'
  | 'http-route'
  | 'sql'
  | 'orm-query'
  | 'external'
  | 'state'
  | 'unresolved';

export interface GraphNode {
  /** Stateless id: the daemon can re-resolve it at any time. */
  id: string;
  kind: NodeKind;
  label: string;
  /** Secondary text, e.g. "POST /api/auth/login" or a package name. */
  detail?: string;
  source?: SourceRef;
  /** Whether asking the daemon for this node's relations can return anything. */
  expandable: boolean;
}

export type RelationKind =
  | 'handles'
  | 'calls'
  | 'constructs'
  | 'renders'
  | 'requests'
  | 'routes-to'
  | 'middleware'
  | 'queries'
  | 'implemented-by';

export interface Relation {
  kind: RelationKind;
  evidence: Evidence;
  target: GraphNode;
  /** Why TraceNaut believes this, in plain words. */
  note?: string;
  /** Where in the source the relationship is expressed (the call site, the JSX attribute…). */
  site?: SourceRef;
  /** Number of distinct sites when several were merged. */
  sites?: number;
}

export interface Token {
  text: string;
  color?: string;
  darkColor?: string;
  fontStyle?: number;
}

/** A clickable range inside a code view that navigates to another node. */
export interface CodeMark {
  line: number;
  col: number;
  endCol: number;
  nodeId: string;
  evidence: Evidence;
}

export interface CodeView {
  service: string;
  file: string;
  absPath: string;
  language: string;
  startLine: number;
  lines: Token[][];
  /** 1-based inclusive line range to emphasise. */
  focus?: { from: number; to: number };
  marks: CodeMark[];
  /** Ranges of code notation with a concept explanation (e.g. `await`, JSX, destructuring). */
  syntax?: SyntaxSpan[];
  truncated?: boolean;
}

export interface SyntaxSpan {
  line: number;
  col: number;
  endCol: number;
  concept: string;
}

// ---------------------------------------------------------------------------
// Inspect

/** One level of the element's ancestry as observed in the running page. */
export interface ChainEntry {
  /** `file:line:col` from data-tn-loc / data-tn-use. */
  loc: string;
  type: 'host' | 'component';
  /** Tag (host) or component display name (component). */
  name: string;
  /** Names of `on*` props holding functions at runtime (React adapter only). */
  runtimeHandlers?: string[];
}

export interface InspectRequest {
  chain: ChainEntry[];
  element: { tag: string; text: string; attributes: Record<string, string> };
  /** Which adapter produced the chain; affects what we can claim. */
  adapter: 'react' | 'dom';
  /**
   * The clicked element itself when it has no source location (a library component drew it,
   * e.g. React Router's <NavLink> renders the <a>). Its handlers then live in library code.
   */
  leaf?: { tag: string; runtimeHandlers: string[] };
}

export interface InspectedLevel {
  entry: ChainEntry;
  /** Tag as written in the JSX (e.g. `AuthContext.Provider`), when the source was found. */
  tag?: string;
  source?: SourceRef;
  /** The function component whose body contains this JSX. */
  owner?: GraphNode;
  /** For component usages: where the component is defined. */
  definition?: GraphNode;
  error?: string;
}

export interface HandlerInfo {
  event: string;
  /** The JSX where the handler is attached (may be an ancestor of the clicked element). */
  attachedAt: SourceRef;
  attachedTo: string;
  /** Present when the clicked element is not the element the handler sits on. */
  via?: string;
  /** Whether the handler was observed as a function prop at runtime. */
  runtimeAttached: boolean;
  relation: Relation;
  /** Prop hops walked to reach the definition, e.g. "onToggle ← TaskBoard.tsx:20". */
  hops: string[];
}

export interface InspectResult {
  element: InspectRequest['element'];
  levels: InspectedLevel[];
  /** Index into levels of the most meaningful level to show first. */
  primary: number;
  handlers: HandlerInfo[];
  notes: string[];
}

export interface NodeDetail {
  node: GraphNode;
  code?: CodeView;
  /** Free-form facts, e.g. SQL text, route method/path. */
  facts: { label: string; value: string }[];
  relations: Relation[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Runtime tracing

export interface ProbeCallWire {
  t: number;
  id: string;
  parent: number;
  at: number;
  end?: number;
  /** Root calls: ran while the user's event was being dispatched (so the event ran it). */
  ev?: true;
}

export interface ClientRequestRecord {
  seq: number;
  method: string;
  url: string;
  /** Probe token of the function that issued the request. */
  initiator: number;
  at: number;
  end?: number;
  status?: number;
  error?: string;
  /** Whether a trace header was attached (same-origin requests only). */
  correlated: boolean;
}

export interface ActionRecord {
  type: string;
  at: number;
  tag: string;
  text: string;
  loc?: string;
}

/** Query parameters whose values are never recorded (tokens, keys, passwords, one-time codes…). */
export const SENSITIVE_PARAM = /(token|key|pass(word)?|pwd|secret|auth|session|sid|code|sig(nature)?|jwt|credential|otp)/i;

/** `path?query` with sensitive parameter values replaced by `•••`; other values are kept. */
export function redactQuery(pathAndQuery: string): string {
  const q = pathAndQuery.indexOf('?');
  if (q < 0) return pathAndQuery;
  const hash = pathAndQuery.indexOf('#', q);
  const query = pathAndQuery.slice(q + 1, hash < 0 ? undefined : hash);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = decodeURIComponentSafe(eq < 0 ? pair : pair.slice(0, eq));
    return eq >= 0 && SENSITIVE_PARAM.test(name) ? `${pair.slice(0, eq)}=•••` : pair;
  });
  return `${pathAndQuery.slice(0, q)}?${parts.join('&')}`;
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface FrontendTracePayload {
  action?: ActionRecord;
  /** True when the client marks root calls run by the event (`ev`); older clients do not. */
  eventMarks?: boolean;
  calls: ProbeCallWire[];
  requests: ClientRequestRecord[];
  dropped: number;
  durationMs: number;
}

export interface AgentSqlRecord {
  sql: string;
  op: string;
  /** Probe token that executed the statement. */
  caller: number;
  at: number;
  durationMs: number;
  rows?: number;
  error?: string;
}

export interface AgentRequestRecord {
  seq: number;
  method: string;
  url: string;
  status?: number;
  /** Express-style matched route, when the framework exposes it. */
  route?: string;
  at: number;
  durationMs?: number;
  calls: ProbeCallWire[];
  sql: AgentSqlRecord[];
  dropped: number;
}

export interface TraceCall {
  node: GraphNode;
  probe: string;
  at: number;
  /** Root calls: run by the recorded event's dispatch (a handler), not by a timer or frame. */
  byEvent?: boolean;
  durationMs?: number;
  children: TraceCall[];
  /** Requests issued while this call was on top of the stack. */
  requests: TraceRequest[];
  sql: (AgentSqlRecord & { evidence: 'runtime' })[];
}

export interface TraceRequest {
  at?: number;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  error?: string;
  server?: {
    service: string;
    route?: string;
    routeNode?: GraphNode;
    calls: TraceCall[];
    sql: AgentSqlRecord[];
    dropped: number;
  };
  /** Why there is no server-side detail, if there is none. */
  serverNote?: string;
}

export interface TraceResult {
  id: string;
  action?: ActionRecord & { source?: SourceRef };
  durationMs: number;
  calls: TraceCall[];
  renders: { node: GraphNode; count: number }[];
  /** Requests issued outside any instrumented function (e.g. from library code). */
  orphanRequests: TraceRequest[];
  agents: { service: string; connected: boolean }[];
  notes: string[];
  /** Root calls carry `byEvent` (which ones the user's event ran). */
  eventMarks?: boolean;
  /** The same execution, told as a journey. */
  flow?: Flow;
}

export interface StatusResult {
  repoRoot: string;
  services: { name: string; root: string; kind: string }[];
  agents: { service: string; pid: number }[];
  editor: string;
  ai: { available: boolean; model?: string };
  assetsVersion?: string;
}

// ---------------------------------------------------------------------------
// Journeys: behaviour first, implementation on demand

export type Zone = 'browser' | 'network' | 'server' | 'database';

export type TechKind = 'language' | 'library' | 'framework' | 'runtime' | 'protocol' | 'data-format' | 'database' | 'browser-api' | 'tool' | 'platform' | 'service';

/** A technology identified from project evidence (never from guesses). */
export interface TechRef {
  /** Concept id in the client's concept library. */
  id: string;
  name: string;
  kind: TechKind;
  /** How TraceNaut knows, e.g. "LoginForm.tsx imports from 'react'". */
  evidence: string;
  /** What it does in this particular step. */
  role?: string;
  /** Icon to draw (an official-logo tile or a TraceNaut icon), from the asset registry. */
  asset?: string;
  /** True when `asset` is an official logo (a trademark of its owner). */
  logo?: boolean;
  /** Plain explanation from the registry, used when no curated concept card exists. */
  what?: string;
  effect?: string;
}

/** A technology found in the repository, with the evidence and what TraceNaut can do with it. */
export interface StackTech {
  id: string;
  name: string;
  kind: TechKind;
  category: string;
  asset: string;
  logo: boolean;
  what?: string;
  effect?: string;
  evidence: string[];
  support: { visual: boolean; detect: boolean; static: boolean; runtime: boolean; trace: boolean; explain: boolean };
}

export interface StackResult {
  techs: StackTech[];
  scanned: { files: number; ms: number; truncated: boolean };
}

export type StepType =
  | 'interaction'
  | 'ui-logic'
  | 'client-logic'
  | 'request'
  | 'server-entry'
  | 'server-logic'
  | 'database'
  | 'response'
  | 'ui-update'
  | 'unknown';

export interface FlowFunction {
  node: GraphNode;
  /** Label of the function (or event) that made it run, within this journey. */
  calledBy?: string;
  /** Parameter names, as written. */
  params: string[];
  /** How certain the link that reached this function is. */
  evidence: Evidence;
  note?: string;
  ran?: boolean;
  durationMs?: number;
}

export interface FlowFact {
  label: string;
  /** May contain [[label|conceptId]] term markup. */
  value: string;
  evidence?: Evidence;
}

export interface CodeAnchor {
  nodeId: string;
  label: string;
}

export interface FlowStep {
  id: string;
  type: StepType;
  zone: Zone;
  /** Plain title derived from code structure, e.g. "Sends a request to the server". */
  title: string;
  /** One line under the title, e.g. "POST /api/auth/login". */
  subtitle?: string;
  /** What happens, in plain words. May contain [[label|conceptId]] term markup. */
  summary: string;
  /** Certainty of the link into this step. */
  evidence: Evidence;
  evidenceNote?: string;
  tech: TechRef[];
  functions: FlowFunction[];
  facts: FlowFact[];
  code: CodeAnchor[];
  /** Matching keys used to compare a static journey with an observed one. */
  keys: string[];
  /** server-entry: what runs before the route's own code, in order. */
  middleware?: string[];
  /**
   * Observed: code that ran during the recording without being shown to follow from the
   * action (timers, animation frames, effects that send nothing). Long runs are folded.
   */
  incidental?: boolean;
  /** response: the different answers the code can give (one per status), for drawing branches. */
  branches?: { status: number | '?'; label: string }[];
  /** Observed-only: e.g. HTTP status, SQL rows. */
  observed?: { status?: number; durationMs?: number };
}

export interface Flow {
  /** "What happens when you click “Sign in”?" */
  question: string;
  /** The answer in one short sentence, shown first. */
  headline: string;
  /** Plain overview; may contain term markup. */
  summary: string;
  /** Where the element comes from, e.g. "Part of the LoginForm component". */
  context?: string;
  mode: 'static' | 'observed';
  steps: FlowStep[];
  notes: string[];
}

export interface JourneyResult {
  inspect: InspectResult;
  flows: Flow[];
}
