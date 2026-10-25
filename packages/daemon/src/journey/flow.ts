import type {
  AgentSqlRecord,
  CodeAnchor,
  Evidence,
  Flow,
  FlowFact,
  FlowFunction,
  FlowStep,
  GraphNode,
  HandlerInfo,
  InspectRequest,
  InspectResult,
  Relation,
  StepType,
  TechRef,
  TraceCall,
  TraceRequest,
  TraceResult,
  Zone,
} from '@tracenaut/protocol';
import { type Analyzer, sqlTables } from '../analysis/analyzer.js';
import { TechDetector, fromRegistry, techForModule } from './tech.js';
import { ormPhrase } from '../analysis/orm.js';

/**
 * Journeys tell one interaction as a short sequence of steps, grouped by where the code
 * runs (browser → network → server → database). Steps are built from the analyzer's
 * relations (static) or from a recorded trace (observed). Every sentence is assembled
 * from structure the analyzer verified — calls, SQL text, request bodies, response
 * calls — never from what a function's name suggests.
 *
 * Text may contain [[label|concept]] markup, which the client turns into explainable terms.
 */

type Ev = Evidence;
const RANK: Record<Ev, number> = { unresolved: 0, inferred: 1, static: 2, runtime: 3 };
const weakest = (list: Ev[]): Ev => list.reduce<Ev>((a, b) => (RANK[b] < RANK[a] ? b : a), 'runtime');
const FN_KINDS = new Set(['function', 'hook', 'method', 'component']);

type FnEvt = {
  t: 'fn';
  /** Ran later, from a timer or debounce that the inspected element's code sets up. */
  scheduled?: boolean;
  node: GraphNode;
  zone: 'browser' | 'server';
  ui: boolean;
  evidence: Ev;
  note?: string;
  calledBy?: string;
  params: string[];
  durationMs?: number;
};
type ReqEvt = {
  t: 'request';
  /** A React Server Action call: the framework posts the form/arguments to the server. */
  serverAction?: string;
  /** Sent by server code to another service (observed only). */
  fromServer?: boolean;
  /** …to the very same server (a framework fetching its own page data, e.g. after a redirect). */
  toSelf?: boolean;
  node?: GraphNode;
  method: string;
  path: string;
  shape?: 'literal' | 'parametric' | 'prefixed' | 'partial';
  bodyKeys?: string[];
  format?: 'JSON';
  via?: string;
  chain?: string[];
  client?: 'fetch' | 'axios';
  assumedBase?: string;
  fetchAt?: string;
  evidence: Ev;
  note?: string;
  owner: string;
  status?: number;
  durationMs?: number;
  error?: string;
  routeId?: string;
};
type RouteEvt = {
  t: 'route';
  node?: GraphNode;
  service?: string;
  middleware: { label: string; library: boolean }[];
  evidence: Ev;
  note?: string;
  missing?: string;
  serverAction?: string;
};
type SqlEvt = {
  t: 'sql';
  /** SQL text, or for an ORM call the call itself (`Website.findUnique`): ORM calls carry no SQL. */
  text: string;
  orm?: { lib: 'Prisma'; model: string; op: string; access: 'read' | 'write'; schemaFile: string };
  /** Observed on the wire: which database protocol carried it (SQL unless mongodb/redis). */
  protocol?: 'postgres' | 'mysql' | 'mongodb' | 'redis';
  node?: GraphNode;
  owner: string;
  evidence: Ev;
  rows?: number;
  service?: string;
  error?: string;
};
type NavEvt = { t: 'navigate'; router: string; to?: string; owner: string; node: GraphNode };
type RespEvt = {
  t: 'response';
  serverAction?: string;
  /** Where a Server Action sends the browser afterwards (redirect('/x')), when written literally. */
  redirectTo?: string;
  routeId?: string;
  handlerId?: string;
  outcomes: { status: number | '?'; sends?: string[]; from: string; role: string }[];
  cookies: { name: string; action: 'sets' | 'clears' }[];
  status?: number;
  evidence: Ev;
  missing?: boolean;
  /** Observed: why no answer arrived (aborted, network error). */
  error?: string;
};
type Evt =
  | NavEvt
  | FnEvt
  | ReqEvt
  | RouteEvt
  | SqlEvt
  | RespEvt
  | { t: 'state'; label: string; owner: string }
  | { t: 'throw'; label: string; owner: string }
  | { t: 'unknown'; label: string; note: string; owner: string }
  | { t: 'renders'; items: { node: GraphNode; count: number }[] }
  | { t: 'then'; repeat?: number };

interface Acc {
  fns: FnEvt[];
  states: string[];
  throws: string[];
  unknowns: { label: string; note: string }[];
  sql: SqlEvt[];
  afterUpdate?: boolean;
  scheduled?: boolean;
  repeat?: number;
  nextIsRequest?: boolean;
  via?: string;
}

export class JourneyBuilder {
  readonly tech: TechDetector;

  constructor(private a: Analyzer) {
    this.tech = new TechDetector(a);
  }

  // ======================================================================== static

  staticFlows(req: InspectRequest, inspect: InspectResult): Flow[] {
    if (inspect.levels.length === 0) return [this.noSourceFlow(req, inspect)];
    if (inspect.handlers.length === 0) return [this.noHandlerFlow(req, inspect)];
    return inspect.handlers.slice(0, 4).map((h) => this.staticFlow(req, inspect, h));
  }

  private staticFlow(req: InspectRequest, inspect: InspectResult, handler: HandlerInfo): Flow {
    const events: Evt[] = [];
    const visited = new Set<string>();
    const viaResolved = new Set<string>();
    let fnCount = 0;

    // `side` is set once the walk has crossed a request into server code; it matters for
    // full-stack services (Next.js) whose server routes sit beside the browser code.
    const walk = (node: GraphNode, evidence: Ev, note: string | undefined, calledBy: string | undefined, depth: number, side?: 'server') => {
      if (visited.has(node.id) || depth > 14 || fnCount >= 60) return;
      // Browser code calling a Server Action: the call crosses to the server here.
      if (side !== 'server' && this.a.isServerAction(node.id)) {
        const crossing: Ev = evidence === 'unresolved' ? 'unresolved' : 'static';
        events.push({ t: 'request', method: 'POST', path: '(to this page)', evidence: crossing, owner: calledBy ?? 'the page', serverAction: node.label, node });
        events.push({ t: 'route', node: undefined, service: node.source?.service, middleware: [], evidence: crossing, serverAction: node.label });
        walk(node, evidence, note, 'the Server Action call', depth + 1, 'server');
        events.push({ t: 'response', outcomes: [], cookies: [], evidence: crossing, serverAction: node.label, redirectTo: this.a.redirectTarget(node.id) });
        return;
      }
      visited.add(node.id);
      fnCount++;
      const fn = this.a.fnById(node.id);
      events.push({ t: 'fn', node, zone: side ?? this.zoneOf(node), ui: !!node.source && this.a.fileHasJsx(node.source.file), evidence, note, calledBy, params: fn ? this.a.paramsOf(fn) : [] });
      for (const r of this.a.flowRelations(node.id)) {
        const kind = r.target.kind;
        if (r.kind === 'requests') {
          // A wrapper's own fetch(`/api${path}`) was already resolved at its call site.
          if (viaResolved.has(node.id) && r.evidence === 'unresolved') continue;
          // Inside a generic request helper (its address comes from its parameters), the
          // helper's own request is already shown where the helper is called.
          if (r.evidence === 'unresolved' && this.a.isRequestWrapper(node.id)) continue;
          walkRequest(r, node, depth);
        } else if (r.kind === 'navigates') {
          events.push({ t: 'navigate', router: r.target.detail ?? 'router', to: r.note?.startsWith('changes the page to ') && !r.note.includes('computed at runtime') ? r.note.slice(20) : undefined, owner: node.label, node: r.target });
        } else if (r.kind === 'queries' && r.target.kind === 'orm-query') {
          const o = this.a.ormAt(r.target.id);
          if (o)
            events.push({
              t: 'sql',
              text: `${o.model}.${o.op}`,
              orm: { lib: o.orm, model: o.model, op: o.op, access: o.access, schemaFile: o.schemaFile },
              node: r.target,
              owner: node.label,
              evidence: r.evidence,
              service: node.source?.service,
            });
        } else if (r.kind === 'queries') {
          events.push({ t: 'sql', text: this.sqlText(r.target), node: r.target, owner: node.label, evidence: 'static', service: node.source?.service });
        } else if (r.kind === 'constructs') {
          if (r.note === 'thrown as an error') events.push({ t: 'throw', label: r.target.label, owner: node.label });
        } else if (r.kind === 'calls' || r.kind === 'implemented-by') {
          if (FN_KINDS.has(kind) && r.target.expandable) walk(r.target, r.evidence, r.note, node.label, depth + 1, side);
          else if (kind === 'state') events.push({ t: 'state', label: r.target.label, owner: node.label });
          // Method calls on plain values (`text.split()`) are data handling, not app structure.
          else if (kind === 'unresolved' && !r.target.label.includes('.')) events.push({ t: 'unknown', label: r.target.label, note: r.note ?? 'could not be resolved', owner: node.label });
        }
      }
    };

    const walkRequest = (r: Relation, owner: GraphNode, depth: number) => {
      const d = this.a.requestDetails(r.target.id);
      if (d?.viaId) {
        const viaFn = this.a.fnById(d.viaId);
        viaResolved.add(d.viaId);
        // The wrapper runs before the request leaves, so it comes first in the journey.
        if (viaFn && !visited.has(d.viaId)) walk(this.a.fnNode(viaFn), 'static', 'sends the request', owner.label, depth + 1);
      }
      const routes = this.a.flowRelations(r.target.id);
      const route = routes[0];
      events.push({
        t: 'request',
        node: r.target,
        method: d?.method ?? '?',
        path: d?.pattern ?? r.target.label,
        shape: d?.shape,
        bodyKeys: d?.bodyKeys,
        format: d?.format,
        via: d?.via,
        chain: d?.chain,
        client: d?.client,
        assumedBase: d?.assumedBase,
        fetchAt: d ? `${d.fetchFile.split('/').pop()}:${d.fetchLine}` : undefined,
        evidence: r.evidence,
        note: r.note,
        owner: owner.label,
        routeId: route?.target.id,
      });
      if (!route) {
        events.push({
          t: 'route',
          middleware: [],
          evidence: 'unresolved',
          missing:
            d?.shape === 'partial'
              ? 'Part of the address is only known when the code runs, so the receiving server code cannot be determined by reading it.'
              : 'No route in the configured server code matches this address.',
        });
        events.push({ t: 'response', outcomes: [], cookies: [], evidence: 'unresolved', missing: true });
        return;
      }
      const rels = this.a.flowRelations(route.target.id);
      const mws = rels.filter((x) => x.kind === 'middleware');
      const handlerRel = rels.find((x) => x.kind === 'handles');
      events.push({
        t: 'route',
        node: route.target,
        service: route.target.source?.service,
        middleware: mws.map((m) => ({
          label: m.target.kind === 'external' ? `${m.target.detail}.${m.target.label}()` : m.target.label,
          library: m.target.kind === 'external',
        })),
        evidence: route.evidence,
        note:
          routes.length > 1
            ? `${routes.length} routes match this address; showing the first. ${route.note ?? ''}`
            : route.note,
      });
      for (const m of mws) if (FN_KINDS.has(m.target.kind)) walk(m.target, m.evidence, 'middleware: runs before the route', route.target.label, depth + 1, 'server');
      if (handlerRel && FN_KINDS.has(handlerRel.target.kind)) walk(handlerRel.target, handlerRel.evidence, "the route's code", `the ${route.target.label} route`, depth + 1, 'server');
      const resp = this.a.responseDetails(route.target.id);
      events.push({ t: 'response', routeId: route.target.id, handlerId: handlerRel?.target.id, outcomes: resp.outcomes, cookies: resp.cookies, evidence: 'static' });
    };

    const target = handler.relation.target;
    if (FN_KINDS.has(target.kind) && target.expandable) {
      walk(target, handler.relation.evidence, handler.relation.note, `the “${eventName(handler.event)}” event`, 0);
    } else {
      events.push({ t: 'unknown', label: target.label, note: handler.relation.note ?? 'could not be resolved', owner: handler.event });
    }

    const interaction = this.interactionStatic(req, inspect, handler);
    const steps = this.segment(events, 'static', interaction, req);
    return {
      question: `What happens when you ${verbFor(req.element).present} ${describeTarget(req.element)}?`,
      headline: this.headline(steps, req.element, 'static', handler),
      summary: this.overview(steps, req, 'static', handler),
      context: this.contextLine(inspect),
      mode: 'static',
      steps,
      notes: inspect.notes.filter((n) => !n.startsWith('No event handlers')),
    };
  }

  private noSourceFlow(req: InspectRequest, inspect: InspectResult): Flow {
    return {
      question: `What does ${describeTarget(req.element)} do?`,
      headline: "TraceNaut can't tell: this element isn't linked to the app's source code.",
      summary: "TraceNaut can't tell. This element has no link to the app's source code: it may be created by a library or a script outside the instrumented code.",
      mode: 'static',
      steps: [],
      notes: inspect.notes,
    };
  }

  private noHandlerFlow(req: InspectRequest, inspect: InspectResult): Flow {
    const library = this.libraryHandledFlow(req, inspect);
    if (library) return library;
    const lvl = inspect.levels[inspect.primary] ?? inspect.levels[0];
    const file = lvl?.source?.file;
    const tech = file ? this.tech.forFiles([file]) : [];
    const owner = lvl?.owner?.label;
    const step: FlowStep = {
      id: 's0',
      type: 'interaction',
      zone: 'browser',
      title: `${capital(describeTarget(req.element))} is displayed`,
      subtitle: owner ? `drawn by ${owner}` : undefined,
      summary: `No [[event handler|event-handler]] is attached to this element or to the elements around it that an interaction would reach, so using it does not run any of the app's code.${owner ? ` It is drawn by the ${owner} [[component|component]].` : ''}`,
      evidence: 'static',
      tech,
      functions: [],
      facts: [{ label: 'Element', value: `<${req.element.tag}>` }, ...(owner ? [{ label: 'Drawn by', value: `the ${owner} component` }] : [])],
      code: lvl?.source ? [{ nodeId: `jsx:${lvl.entry.loc}`, label: 'Where this element is written' }] : [],
      keys: ['interaction'],
    };
    return {
      question: `What does ${describeTarget(req.element)} do?`,
      headline: "Nothing: no code in this app reacts when you use it.",
      summary: `It is part of what the page shows. Nothing in the app's code reacts when you interact with it.`,
      context: this.contextLine(inspect),
      mode: 'static',
      steps: [step],
      notes: [],
    };
  }

  /**
   * No handler in the app's own code, but the element is drawn by a library component
   * (`<NavLink>`) or carries handlers that only library code could have attached, or it is a
   * plain link. Then something does happen; TraceNaut says who handles it and that it does
   * not follow library code, instead of claiming that nothing happens.
   */
  private libraryHandledFlow(req: InspectRequest, inspect: InspectResult): Flow | undefined {
    const first = inspect.levels[0];
    const libComponent = first?.entry.type === 'component' && first.definition?.kind === 'external' ? first.definition : undefined;
    const leafHandlers = req.leaf?.runtimeHandlers ?? [];
    const href = req.element.tag === 'a' ? req.element.attributes.href : undefined;
    if (!libComponent && !leafHandlers.length && !href) return undefined;

    const target = describeTarget(req.element);
    const module = libComponent?.detail;
    const reg = module ? techForModule(module) : undefined;
    const tech: TechRef[] = [];
    if (reg) {
      const ref = fromRegistry(reg.id, `<${libComponent!.label}> is imported from '${module}' where the element is written`, 'draws this element and handles its events');
      if (ref) tech.push(ref);
    }
    const events = leafHandlers.map((h) => `“${eventName(h)}”`);
    const parts: string[] = [];
    if (libComponent) {
      parts.push(`This element is drawn by <${libComponent.label}>, a [[component|component]] from the ${module} [[library|npm-package]], not by the app's own code.`);
      parts.push(
        events.length
          ? `Its ${list(events)} [[event handler|event-handler]]${events.length > 1 ? 's are' : ' is'} part of that library, which TraceNaut does not follow.`
          : 'Whatever it does when used is up to that library, which TraceNaut does not follow.',
      );
    } else if (events.length) {
      parts.push(`It has ${list(events)} [[event handler|event-handler]]${events.length > 1 ? 's' : ''} at runtime, but none is written in the app's code that TraceNaut reads: library code attached ${events.length > 1 ? 'them' : 'it'}.`);
    }
    if (href) {
      const router = reg?.id === 'remix' ? 'React Router' : reg?.id === 'nextjs' ? 'Next.js' : undefined;
      parts.push(
        router
          ? `It is a link to ${href}. ${router} catches the click and shows the page for that address without reloading the whole page; that page's code then runs${router === 'Next.js' ? ` (its [[Server Components|server-component]] run on the server)` : ''}.`
          : `It is a link to ${href}${leafHandlers.includes('onClick') ? ', although a click handler may change what happens' : ''}: the browser goes to that address.`,
      );
    }
    parts.push('Use “Watch it happen” to see which of the app’s own code runs as a result.');
    const owner = first?.owner?.label;
    const step: FlowStep = {
      id: 's0',
      type: 'interaction',
      zone: 'browser',
      title: libComponent ? `${capital(target)} is handled by ${libComponent.label}` : href ? `${capital(target)} is a link` : `${capital(target)} is handled by library code`,
      subtitle: href ?? (owner ? `in ${owner}` : undefined),
      summary: parts.join(' '),
      // That a library draws it is read from the code; what the library does is not followed.
      evidence: libComponent || !events.length ? 'static' : 'unresolved',
      evidenceNote: 'TraceNaut reads the app’s code, not the code inside libraries.',
      tech: [...tech, ...(first?.source ? this.tech.forFiles([first.source.file]) : [])],
      functions: [],
      facts: [
        { label: 'Element', value: `<${req.element.tag}>` },
        ...(libComponent ? [{ label: 'Drawn by', value: `<${libComponent.label}> from ${module}` }] : []),
        ...(events.length ? [{ label: 'Handlers (seen running)', value: leafHandlers.join(', '), evidence: 'runtime' as const }] : []),
        ...(href ? [{ label: 'Goes to', value: href }] : []),
      ],
      code: first?.source ? [{ nodeId: `jsx:${first.entry.loc}`, label: 'Where this element is written' }] : [],
      keys: ['interaction'],
    };
    return {
      question: `What does ${target} do?`,
      headline: libComponent
        ? `${reg ? `${reg.name}'s` : `The ${module} library's`} <${libComponent.label}> handles it${href ? `: it leads to ${href}` : ''}.`
        : href
          ? `It is a link to ${href}.`
          : 'Library code handles it; TraceNaut does not follow library code.',
      summary: parts.join(' '),
      context: this.contextLine(inspect),
      mode: 'static',
      steps: [step],
      notes: [],
    };
  }

  private interactionStatic(req: InspectRequest, inspect: InspectResult, handler: HandlerInfo): FlowStep {
    const el = req.element;
    const verb = verbFor(el);
    const ev = eventName(handler.event);
    let summary: string;
    const inside = !['button', 'input'].includes(req.element.tag);
    const control = inside ? `This ${req.element.tag === 'svg' ? 'icon' : `<${req.element.tag}>`} is inside a submit button of a [[form|html-form]]` : `This [[button|html-element]] is inside a [[form|html-form]]`;
    if (handler.event === 'action') {
      summary = `${handler.via ? `${control}, so ${verb.ing} it submits the form. ` : ''}The form has an action: a function React calls with the form's fields when it is submitted, instead of the browser loading a new page.`;
    } else if (handler.event === 'onSubmit' && handler.via) {
      summary = `${control}, so ${verb.ing} it submits the form. Submitting runs the form's [[event handler|event-handler]] for the “submit” event.`;
    } else if (handler.via) {
      summary = `The element itself has no handler. The “${ev}” event [[bubbles up|event-bubbling]] to an enclosing ${handler.attachedTo}, which has an [[event handler|event-handler]] for it.`;
    } else {
      summary = `This element has an [[event handler|event-handler]] for the “${ev}” event: code that runs when it happens.`;
    }
    if (handler.hops.length) {
      summary += ` The handler is written in another [[component|component]] and handed down through [[props|props]] before it reaches this element.`;
    }
    const lvl = inspect.levels[inspect.primary] ?? inspect.levels[0];
    const file = lvl.source?.file ?? handler.attachedAt.file;
    const detected = this.tech.forFiles([file]);
    if (req.adapter === 'react' && !detected.some((t) => t.id === 'react')) {
      // Modern JSX needs no React import, but the live page proves React drew this element.
      detected.push({ id: 'react', name: 'React', kind: 'library', evidence: 'read from the running page: React drew this element' });
    }
    const tech = detected.map((t) =>
      t.id === 'react' ? { ...t, role: 'draws this element, and calls the handler when the event happens' } : t.kind === 'language' ? { ...t, role: 'the language this part of the page is written in' } : t,
    );
    const facts: FlowFact[] = [
      { label: 'Element', value: `<${el.tag}>${el.text ? ` “${trim(el.text, 40)}”` : ''}` },
      ...(lvl.owner ? [{ label: 'Drawn by', value: `the ${lvl.owner.label} [[component|component]]` }] : []),
      { label: 'Listens for', value: `“${ev}”, on ${handler.attachedTo}` },
      ...(handler.hops.length
        ? [{ label: 'Handed down', value: `as a [[prop|props]] into ${list([...new Set(handler.hops.map((h) => /<(\w+)>/.exec(h)?.[1]).filter((x): x is string => !!x))].map((c) => `the ${c} component`))}` }]
        : []),
      handler.runtimeAttached
        ? { label: 'Live check', value: 'the handler is attached in the running page right now', evidence: 'runtime' as const }
        : { label: 'Live check', value: 'not confirmed in the running page', evidence: 'unresolved' as const },
    ];
    const code: CodeAnchor[] = [];
    if (lvl.source) code.push({ nodeId: `jsx:${lvl.entry.loc}`, label: 'Where this element is written' });
    const attached = `jsx:${handler.attachedAt.file}:${handler.attachedAt.line}:${handler.attachedAt.col}`;
    if (!code.some((c) => c.nodeId === attached)) code.push({ nodeId: attached, label: 'Where the handler is attached' });
    return {
      id: 's0',
      type: 'interaction',
      zone: 'browser',
      title: `You ${verb.present} ${describeTarget(el)}`,
      subtitle: (handler.event === 'onSubmit' || handler.event === 'action') && handler.via ? 'submits the form' : handler.event === 'action' ? 'form action' : `${ev} event`,
      summary,
      evidence: handler.relation.evidence === 'unresolved' ? 'unresolved' : 'static',
      evidenceNote: handler.relation.evidence === 'unresolved' ? handler.relation.note : undefined,
      tech,
      functions: [],
      facts,
      code,
      keys: ['interaction'],
    };
  }

  // ======================================================================== observed

  observedFlow(trace: TraceResult): Flow {
    const events: Evt[] = [];
    let prevSignature = '';
    // Which top-level calls did the user's event run? The client marks calls that started
    // while the event was being dispatched; everything else (animation frames, timers,
    // effects) only "also ran". Without marks (older clients) the first call is assumed.
    const byEvent = (root: TraceCall, i: number) => (trace.eventMarks ? !!root.byEvent : i === 0);
    let rendersShown = false;
    // Requests sent by code TraceNaut does not instrument (a router, a data library) are placed
    // in time order among the recorded calls.
    const orphans = [...trace.orphanRequests].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const flushOrphans = (before: number) => {
      while (orphans.length && (orphans[0].at ?? 0) <= before) this.visitRequest(orphans.shift()!, 'code outside the instrumented files', events);
    };
    trace.calls.forEach((root, i) => {
      // Run by the event, or (likely) scheduled by it: the element's own code leads to it.
      const caused = byEvent(root, i) || !!root.scheduled;
      flushOrphans(root.at);
      const signature = callSignature(root);
      if (i > 0 && signature === prevSignature) {
        events.push({ t: 'then', repeat: 2 });
        return;
      }
      if (!caused && !rendersShown && trace.renders.length) {
        events.push({ t: 'renders', items: trace.renders });
        rendersShown = true;
      }
      if (!caused) events.push({ t: 'then' });
      prevSignature = signature;
      this.visitCall(root, root.scheduled ? 'code your action scheduled' : caused ? 'the event' : undefined, events, undefined, root.scheduled);
    });
    flushOrphans(Infinity);
    if (!rendersShown && trace.renders.length) events.push({ t: 'renders', items: trace.renders });

    const action = trace.action;
    const el = { tag: action?.tag ?? '?', text: action?.text ?? '', attributes: {} };
    const verb = verbFor(el);
    const interaction: FlowStep = {
      id: 's0',
      type: 'interaction',
      zone: 'browser',
      title: action ? `You ${verb.past} ${describeTarget(el)}` : 'No interaction was recorded',
      subtitle: action?.type,
      summary: action ? `The browser registered these events, in order: ${action.type}.` : 'Nothing was clicked or typed while the recording was armed.',
      evidence: action ? 'runtime' : 'unresolved',
      tech: action?.source ? this.tech.forFiles([action.source.file]) : [],
      functions: [],
      facts: action ? [{ label: 'Events', value: action.type, evidence: 'runtime' }, { label: 'Element', value: `<${el.tag}>${el.text ? ` “${trim(el.text, 40)}”` : ''}` }] : [],
      code: action?.loc ? [{ nodeId: `jsx:${action.loc}`, label: 'Where this element is written' }] : [],
      keys: ['interaction'],
    };
    const steps = this.segment(events, 'observed', interaction);
    if (trace.unattributed?.length) steps.push({ ...this.unattributedStep(trace.unattributed), id: `s${steps.length}` });
    for (const ws of trace.sockets ?? [])
      steps.push({
        id: `s${steps.length}`,
        type: 'request',
        zone: 'network',
        title: 'Messages over a live connection',
        subtitle: `${ws.url} · ${ws.sent} sent · ${ws.received} received`,
        summary: `The page ${ws.opened ? 'opened' : 'already had'} a [[WebSocket|websocket]] connection to ${ws.url}: it stays open, and either side can send a message at any time. During the recording, ${ws.sent} message${ws.sent === 1 ? ' was' : 's were'} sent and ${ws.received} received. TraceNaut counts them but does not read them, and cannot tell which ones your action caused.`,
        evidence: 'runtime',
        tech: [fromRegistry('websocket', 'messages were observed on the connection', 'keeps a two-way connection open')].filter((t): t is TechRef => !!t),
        functions: [],
        facts: [
          { label: 'Address', value: ws.url },
          { label: 'Sent', value: String(ws.sent), evidence: 'runtime' },
          { label: 'Received', value: String(ws.received), evidence: 'runtime' },
        ],
        code: [],
        keys: [`ws:${ws.url}`],
        incidental: !ws.sent,
      });
    if (trace.notes.some((n) => n.startsWith('Your action loaded a completely new page')))
      steps.push({
        id: `s${steps.length}`,
        type: 'navigation',
        zone: 'browser',
        title: 'The browser loaded a new page',
        subtitle: 'the recording stops here',
        summary: 'The action replaced the whole page (a full page load, not an in-app change). The old page and its code stopped; TraceNaut finished the recording on the new page, so code that ran on the new page is not part of it.',
        evidence: 'runtime',
        tech: [],
        functions: [],
        facts: [],
        code: [],
        keys: ['nav:full-load'],
      });
    return {
      question: action ? `What happened when you ${verb.past} ${describeTarget(el)}?` : 'What happened?',
      headline: this.headline(steps, el, 'observed'),
      summary: this.overview(steps, undefined, 'observed'),
      mode: 'observed',
      steps,
      notes: trace.notes,
    };
  }

  /** `side` is 'server' for calls the Node agent reported: they ran on the server wherever the file lives. */
  private visitCall(c: TraceCall, calledBy: string | undefined, events: Evt[], side?: 'server', scheduled?: boolean) {
    const fn = this.a.fnById(c.node.id);
    events.push({
      t: 'fn',
      scheduled,
      node: c.node,
      zone: side ?? this.zoneOf(c.node),
      ui: !!c.node.source && this.a.fileHasJsx(c.node.source.file),
      evidence: 'runtime',
      calledBy,
      params: fn ? this.a.paramsOf(fn) : [],
      durationMs: c.durationMs,
    });
    type Item = { at: number; call?: TraceCall; req?: TraceRequest; sql?: TraceCall['sql'][number] };
    const items: Item[] = [
      ...c.children.map((call) => ({ at: call.at, call })),
      ...c.requests.map((req) => ({ at: req.at ?? Number.MAX_SAFE_INTEGER, req })),
      ...c.sql.map((sql) => ({ at: sql.at, sql })),
    ].sort((x, y) => x.at - y.at);
    for (const it of items) {
      if (it.call) this.visitCall(it.call, c.node.label, events, side);
      else if (it.req) this.visitRequest(it.req, c.node.label, events);
      else if (it.sql) events.push(this.observedSql(it.sql, c.node.label, c.node.source?.service));
    }
  }

  private visitRequest(r: TraceRequest, owner: string, events: Evt[]) {
    const routeId = r.server?.routeNode?.id;
    events.push({ t: 'request', method: r.method, path: r.url, evidence: 'runtime', owner, status: r.status, durationMs: r.durationMs, error: r.error, routeId, fromServer: r.fromServer, toSelf: r.toSelf, serverAction: r.server?.action });
    if (r.server) {
      const likely = r.server.routeEvidence === 'inferred';
      events.push({
        t: 'route',
        node: r.server.routeNode,
        service: r.server.service,
        middleware: [],
        // The request certainly reached this server; which route took it is only certain when
        // the framework said so or the route's handler was seen running.
        evidence: likely ? 'inferred' : 'runtime',
        note: r.server.route ? `matched ${r.server.route}` : likely ? 'matched by method and address; its handler was not seen running' : undefined,
        serverAction: r.server.action,
      });
      const label = r.server.routeNode?.label ?? r.server.route ?? 'the route';
      for (const c of r.server.calls) this.visitCall(c, `the ${label} route`, events, 'server');
      for (const q of r.server.sql) events.push(this.observedSql(q, 'the server', r.server.service));
      for (const nested of r.server.requests ?? []) this.visitRequest(nested, 'the server', events);
      const route = routeId ? this.a.routeById(routeId) : undefined;
      const resp = route ? this.a.responseDetails(routeId!) : { cookies: [] };
      events.push({ t: 'response', routeId, outcomes: [], cookies: resp.cookies, status: r.status, evidence: 'runtime' });
    } else {
      events.push({ t: 'route', middleware: [], evidence: 'unresolved', missing: `The server side was not observed: ${r.serverNote ?? 'no instrumented server handled it'}.` });
      events.push({ t: 'response', outcomes: [], cookies: [], status: r.status, evidence: r.status || r.error ? 'runtime' : 'unresolved', missing: !r.status, error: r.error });
    }
  }

  /** A recorded statement. One the driver sent later (from its queue) is only likely this request's. */
  private observedSql(q: AgentSqlRecord, owner: string, service?: string): SqlEvt {
    return { t: 'sql', text: q.sql, owner, evidence: q.deferred ? 'inferred' : 'runtime', rows: q.rows, service, error: q.error, protocol: q.protocol };
  }

  // ======================================================================== segmentation

  private segment(events: Evt[], mode: 'static' | 'observed', interaction: FlowStep, req?: InspectRequest): FlowStep[] {
    const steps: FlowStep[] = [interaction];
    const accs = new Map<FlowStep, Acc>();
    let cur: FlowStep | undefined;
    let pending: { req: ReqEvt; sql: SqlEvt[] } | undefined;
    const outer: (typeof pending)[] = [];
    let afterUpdate = false;
    let repeatTarget: FlowStep | undefined;
    const states: string[] = [];
    let uiUpdateDone = false;

    const push = (s: Omit<FlowStep, 'id'>) => {
      const step = { ...s, id: `s${steps.length}` } as FlowStep;
      steps.push(step);
      return step;
    };
    const newFnStep = (type: StepType, zone: Zone) => {
      const step = push({ type, zone, title: '', summary: '', evidence: 'static', tech: [], functions: [], facts: [], code: [], keys: [] });
      accs.set(step, { fns: [], states: [], throws: [], unknowns: [], sql: [], afterUpdate });
      if (afterUpdate) {
        repeatTarget = step;
        afterUpdate = false;
      }
      return step;
    };

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.t) {
        case 'fn': {
          const type: StepType = e.zone === 'server' ? 'server-logic' : e.ui ? 'ui-logic' : 'client-logic';
          // Several unrelated bits of code that ran later in a recording (timers, animation
          // frames) form one "Also ran" step rather than one step each.
          let merged = false;
          if (!cur && afterUpdate && mode === 'observed' && e.zone === 'browser') {
            const last = steps[steps.length - 1];
            const acc = last && accs.get(last);
            const effect = (f?: FnEvt) => !!f?.node.label.startsWith('useEffect callback');
            if (acc?.afterUpdate && last.zone === 'browser' && !acc.nextIsRequest && !effect(acc.fns[0]) && !effect(e)) {
              cur = last;
              afterUpdate = false;
              merged = true;
            }
          }
          if (e.scheduled) cur = undefined; // a scheduled call starts its own step
          if (!cur || (!merged && cur.type !== type)) {
            // Code continuing a call that "also ran" also only also ran.
            const inherited = cur ? accs.get(cur)!.afterUpdate : false;
            cur = newFnStep(type, e.zone);
            if (inherited) accs.get(cur)!.afterUpdate = true;
            if (e.scheduled) accs.get(cur)!.scheduled = true;
          }
          accs.get(cur)!.fns.push(e);
          const next = events.slice(i + 1).find((x) => x.t === 'fn' || x.t === 'request');
          if (next?.t === 'request' && type === 'client-logic') {
            accs.get(cur)!.nextIsRequest = true;
            accs.get(cur)!.via = next.via;
          }
          break;
        }
        case 'state':
          states.push(e.label);
          if (cur) accs.get(cur)!.states.push(e.label);
          break;
        case 'throw':
          if (cur) accs.get(cur)!.throws.push(e.label);
          break;
        case 'unknown':
          if (cur) accs.get(cur)!.unknowns.push({ label: e.label, note: e.note });
          else push(this.unknownStep(e.label, e.note));
          break;
        case 'request':
          cur = undefined;
          // A server calling another service: its own statements so far come first, and its
          // request continues after the other service has answered.
          if (pending?.sql.length) {
            push(this.databaseStep(pending.sql, mode));
            pending.sql = [];
          }
          outer.push(pending);
          pending = { req: e, sql: [] };
          push(this.requestStep(e, mode));
          break;
        case 'route':
          cur = undefined;
          push(e.missing ? this.unknownServerStep(e, mode) : this.serverEntryStep(e, mode));
          break;
        case 'sql':
          (pending?.sql ?? []).push(e);
          if (cur) accs.get(cur)!.sql.push(e);
          break;
        case 'response':
          cur = undefined;
          if (pending?.sql.length) push(this.databaseStep(pending.sql, mode));
          if (!e.missing || e.status) push(this.responseStep(e, pending?.req, mode));
          else if (e.error && mode === 'observed') push(this.noAnswerStep(e.error));
          pending = outer.pop();
          break;
        case 'navigate':
          cur = undefined;
          push(this.navigationStep(e));
          break;
        case 'renders':
          cur = undefined;
          push(this.uiUpdateStep(states, e.items, mode, req));
          uiUpdateDone = true;
          break;
        case 'then':
          cur = undefined;
          if (e.repeat) {
            if (repeatTarget) repeatTarget.facts.push({ label: 'Repeated', value: 'this part ran again, identically, right afterwards', evidence: 'runtime' });
          } else afterUpdate = true;
          break;
      }
    }
    if (pending?.sql.length) push(this.databaseStep(pending.sql, mode));
    if (!uiUpdateDone && states.length) {
      const step = push(this.uiUpdateStep(states, [], mode, req));
      if (!step.tech.length) step.tech = interaction.tech.filter((t) => t.id === 'react').map((t) => ({ ...t, role: 'redraws components when their state changes' }));
    }

    for (const [step, acc] of accs) this.finishFnStep(step, acc, mode, steps);
    return steps;
  }

  private finishFnStep(step: FlowStep, acc: Acc, mode: 'static' | 'observed', steps: FlowStep[]) {
    const fns = acc.fns;
    const files = [...new Set(fns.map((f) => f.node.source?.file).filter((f): f is string => !!f))];
    // Packages these functions call into (e.g. bcrypt.compare, z.object): named by the package.
    const used = new Set<string>();
    for (const f of fns)
      for (const r of this.a.flowRelations(f.node.id))
        if (r.target.kind === 'external' && r.target.detail) used.add(r.target.detail.startsWith('@') ? r.target.detail.split('/').slice(0, 2).join('/') : r.target.detail.split('/')[0]);
    step.tech = this.tech.forFiles(files, used);
    step.functions = fns.map<FlowFunction>((f) => ({ node: f.node, calledBy: f.calledBy, params: f.params, evidence: f.evidence, note: f.note, ran: mode === 'observed' ? true : undefined, durationMs: f.durationMs }));
    step.keys = fns.map((f) => f.node.id);
    step.code = fns.slice(0, 4).map((f) => ({ nodeId: f.node.id, label: `${f.node.label}()` }));
    if (mode === 'observed' && acc.afterUpdate && !acc.nextIsRequest && step.zone === 'browser') step.incidental = true;
    step.subtitle = chain(fns.map((f) => friendlyName(f.node.label)));
    step.evidence = mode === 'observed' ? 'runtime' : weakest(fns.map((f) => f.evidence));
    const lang = step.tech.find((t) => t.kind === 'language');
    const langTerm = lang ? `[[${lang.name}|${lang.id}]]` : 'code';
    const parts: string[] = [];

    if (acc.scheduled && mode === 'observed') {
      step.title = acc.nextIsRequest ? 'A moment later, the code it scheduled sends a request' : 'A moment later, the code it scheduled runs';
      parts.push(
        `${fns[0].node.label} ran a little after your action, from a timer rather than directly from the event. TraceNaut links it to your action because the element's code hands this function to a helper that runs it later (for example a debounce, which waits for typing to pause).`,
      );
      step.evidence = 'inferred';
      step.evidenceNote = 'Seen running; linked to your action because the element’s code schedules it.';
    } else if (step.type === 'ui-logic') {
      const fn0 = this.a.fnById(fns[0].node.id);
      const comp = fn0 ? this.a.ownerComponent(fn0) : undefined;
      const isEffect = fns[0].node.label.startsWith('useEffect callback');
      if (acc.afterUpdate && isEffect) {
        step.title = `After the redraw, ${comp ?? 'a component'} runs an effect`;
        parts.push(`This is a [[useEffect|use-effect]] callback in the ${comp ?? ''} [[component|component]]: React runs it after the component is drawn.`);
      } else if (acc.afterUpdate) {
        // Ran later in the recording, outside the first call chain: order is known, cause is not.
        step.title = 'Also ran during the recording';
        parts.push(`This code ran after the first part finished${comp ? `; it belongs to the ${comp} [[component|component]]` : ''}. TraceNaut saw it run while recording, but cannot tell whether your action caused it (a timer or another event could have).`);
      } else {
        step.title = comp ? `The ${comp} component's code runs` : `The page's code runs`;
        parts.push(`This code is part of ${comp ? `the ${comp} [[component|component]]` : 'a component'}, written in ${langTerm}.`);
      }
    } else if (step.type === 'client-logic') {
      const names = files.map((f) => f.split('/').pop()).join(', ');
      if (acc.afterUpdate && fns[0].node.label.startsWith('useEffect callback')) {
        step.title = acc.nextIsRequest ? 'After the redraw, an effect sends a request' : 'After the redraw, an effect runs';
        parts.push(`This is a [[useEffect|use-effect]] callback (in ${names.split(', ')[0]}): React runs it after the component that uses it has been drawn.`);
      } else {
        step.title = acc.afterUpdate ? 'Also ran during the recording' : acc.nextIsRequest ? 'App code prepares the request' : 'App code runs';
        parts.push(`These functions are in ${names}: ordinary ${langTerm} that isn't part of any [[component|component]].`);
        if (acc.afterUpdate) parts.push('They ran after the first part finished; TraceNaut cannot tell whether your action caused them.');
      }
      if (acc.nextIsRequest && acc.via) parts.push(`${acc.via}() uses the browser's [[fetch()|fetch]] to send the request.`);
    } else {
      step.title = mode === 'observed' ? "The server's code ran" : "The server's code handles it";
      const middleware = fns.filter((f) => f.note?.startsWith('middleware'));
      parts.push(`The route's code calls functions in the server's own ${langTerm} files.`);
      if (middleware.length) parts.push(`${list(middleware.map((m) => m.node.label))} ${middleware.length > 1 ? 'run' : 'runs'} first, as [[middleware|middleware]].`);
      const db = dbClause(acc.sql);
      if (db) parts.push(`${mode === 'observed' ? 'It asked' : 'It asks'} the database to ${db}.`);
    }

    if (acc.states.length) parts.push(`It updates [[state|state]] (${list(acc.states)}).`);
    if (acc.throws.length) parts.push(`It can stop with an [[error|error-throw]] (${list(acc.throws)}).`);
    for (const f of fns) {
      if (mode === 'observed' || f.evidence !== 'inferred') continue;
      if (f.note?.includes('declared in type')) {
        parts.push(`${f.node.label} is reached through [[React context|context]]: data a parent component shares with everything inside it. TraceNaut matched it by its type, so this link is likely, not certain.`);
        step.evidenceNote = `${f.node.label} is connected through React context, matched by type. Watch it happen to confirm.`;
      } else if (f.note?.startsWith('prop')) {
        parts.push(`${f.node.label} arrives as a [[prop|props]] from the component that draws this one. TraceNaut found the only place that passes it, so this link is likely, not certain.`);
        step.evidenceNote = `${f.node.label} is passed in as a prop; matched by the only place that passes it.`;
      }
    }
    for (const u of acc.unknowns) parts.push(`TraceNaut couldn't follow ${u.label} (${u.note}).`);
    if (step.evidence === 'unresolved' && !step.evidenceNote) step.evidenceNote = acc.unknowns[0]?.note;
    step.summary = parts.join(' ');
    void steps;
  }

  // ======================================================================== step builders

  private requestStep(e: ReqEvt, mode: 'static' | 'observed'): Omit<FlowStep, 'id'> {
    const method = e.method === '?' ? '' : `[[${e.method}|http-method]] `;
    const parts: string[] = [];
    if (e.toSelf) {
      parts.push(`The server sent a request to itself: ${e.path}. Frameworks do this to prepare the next page, for example after a redirect; it is part of the same action, not another service.`);
      if (e.status) parts.push(`It answered ${e.status} ${statusText(e.status)}.`);
    } else if (e.serverAction) {
      parts.push(
        `${e.serverAction}() is a [[Server Action|server-action]]: code that lives on the server but can be called from the page. Calling it makes the framework send an [[HTTP|http]] POST request to the server with the form's fields (or the arguments); no fetch() is written in the app's code.`,
      );
    } else if (mode === 'observed' && e.fromServer) {
      parts.push(`While handling the request, the server's code sent its own [[HTTP|http]] ${method}request to another service: ${e.path}.`);
      if (e.status) parts.push(`That service answered with [[status|status-code]] ${e.status} ${statusText(e.status)}${e.durationMs !== undefined ? ` after ${Math.round(e.durationMs)} ms` : ''}.`);
      if (e.error) parts.push(`It failed: ${e.error}.`);
    } else if (mode === 'observed') {
      parts.push(`The browser sent an [[HTTP|http]] ${method}request to ${e.path}.`);
      if (e.status) parts.push(`The answer came back with [[status|status-code]] ${e.status} ${statusText(e.status)}${e.durationMs !== undefined ? ` after ${Math.round(e.durationMs)} ms` : ''}.`);
      if (e.error) parts.push(`It failed: ${e.error}.`);
    } else {
      parts.push(`The browser sends an [[HTTP|http]] ${method}request to the address ${e.path}.`);
      if (e.bodyKeys?.length) parts.push(`It carries ${list(e.bodyKeys)} in the [[request body|request-body]]${e.format ? `, written as [[JSON|json]]` : ''}.`);
      if (e.shape === 'parametric') parts.push(`The ${list(placeholders(e.path))} part of the address is filled in when the code runs.`);
      if (e.shape === 'prefixed')
        parts.push(`${e.assumedBase} puts a [[base address|base-url]] in front of it that is only known when the app runs (usually from configuration), so the server route below is a likely match, not a certain one.`);
      if (e.shape === 'partial') parts.push(`Part of the address is only known when the code runs.`);
      if (e.chain && e.chain.length > 1) parts.push(`The request passes through ${list(e.chain.map((c) => `${c}()`))} before it leaves.`);
    }
    const sender = e.client === 'axios' ? 'axios' : 'fetch()';
    const last = e.chain?.[e.chain.length - 1] ?? e.via ?? e.owner;
    const tech: TechRef[] = [this.tech.http(mode === 'observed' ? `the request was observed leaving the ${e.fromServer ? 'server' : 'browser'}` : `${last}() calls ${sender}, which sends HTTP requests`)];
    if (e.format) tech.push(this.tech.json(e.client === 'axios' ? 'axios sends object bodies as JSON' : `${last}() turns the body into text with JSON.stringify`));
    if (mode === 'static') tech.push(e.client === 'axios' ? this.tech.axios(`called in ${e.fetchAt ?? 'the request code'}`) : this.tech.fetch(`called in ${e.fetchAt ?? 'the request code'}`));
    const facts: FlowFact[] = [
      { label: 'Method', value: e.method === '?' ? 'unknown until it runs' : e.method },
      { label: 'Address', value: e.path },
    ];
    if (mode === 'static') facts.push({ label: 'Sends', value: e.bodyKeys?.length ? list(e.bodyKeys) : e.method === 'GET' ? 'nothing (no body)' : 'not determined' });
    if (e.via) facts.push({ label: 'Sent by', value: `${(e.chain?.length ? e.chain : [e.via]).map((c) => `${c}()`).join(' → ')}, using ${sender}` });
    if (e.assumedBase) facts.push({ label: 'Base address', value: `added by ${e.assumedBase} at runtime`, evidence: 'inferred' });
    if (e.status) facts.push({ label: 'Status', value: `${e.status} ${statusText(e.status)}`, evidence: 'runtime' });
    const code: CodeAnchor[] = [];
    if (e.node) code.push({ nodeId: e.node.id, label: 'Browser side: the request is made here' });
    if (e.routeId) code.push({ nodeId: e.routeId, label: 'Server side: the route that receives it' });
    return {
      type: 'request',
      zone: 'network',
      title: e.toSelf ? 'The server asked itself for the next page' : e.serverAction ? `${mode === 'observed' ? 'Called' : 'Calls'} the Server Action ${e.serverAction}()` : e.fromServer ? 'The server called another service' : mode === 'observed' ? 'Sent a request to the server' : 'Sends a request to the server',
      subtitle: `${e.method === '?' ? '' : `${e.method} `}${e.path}`,
      summary: parts.join(' '),
      evidence: e.evidence,
      evidenceNote: e.evidence === 'unresolved' ? 'Part of this request is only known when the code runs.' : undefined,
      tech,
      functions: [],
      facts,
      code,
      keys: [e.routeId ? `route:${e.routeId}` : `req:${e.method} ${e.path}`],
      observed: mode === 'observed' ? { status: e.status, durationMs: e.durationMs } : undefined,
      fromServer: e.fromServer || undefined,
    };
  }

  private serverEntryStep(e: RouteEvt, mode: 'static' | 'observed'): Omit<FlowStep, 'id'> {
    const label = e.node?.label ?? e.note?.replace(/^matched /, '');
    const file = e.node?.source?.file;
    const tech: TechRef[] = [];
    if (e.service) tech.push(this.tech.runtime(e.service));
    // The framework comes from how the route was registered (it may not be imported in this file,
    // e.g. a Fastify plugin or a Next.js route file), else from the file's imports.
    const record = e.node ? this.a.routeById(e.node.id) : undefined;
    const fwId = record ? ROUTE_FRAMEWORK_TECH[record.framework] : undefined;
    const fwRef = fwId ? fromRegistry(fwId, record!.framework === 'next' ? `${file} is a route file in a Next.js app` : `the route is registered with ${record!.declared}`) : undefined;
    if (fwRef) tech.push({ ...fwRef, role: "matches the request to a route and runs that route's code" });
    if (file) {
      if (!fwRef) for (const lib of this.tech.libraries(file)) if (BACKEND_FRAMEWORKS.has(lib.id)) tech.push({ ...lib, role: "matches the request to a route and runs that route's code" });
      tech.push(this.tech.language(file));
    }
    const fw = tech.find((t) => BACKEND_FRAMEWORKS.has(t.id));
    const framework = fw ? `[[${fw.name}|${fw.id}]]` : 'the server framework';
    const parts: string[] = [];
    const page = record?.kind === 'page';
    if (e.serverAction) {
      parts.push(`The framework finds the Server Action ${e.serverAction}() from an id it sent with the request, and runs it on the server.`);
    } else if (page) {
      parts.push(
        `${framework}${e.service ? ` (on [[Node.js|nodejs]])` : ''} ${mode === 'observed' ? 'rendered' : 'renders'} the page ${file} on the server for this address: its [[Server Components|server-component]] run there, fetch their data, and the result is sent to the browser.`,
      );
      parts.push(`Next.js made this page's address from where the file sits ([[file-based routing|file-routing]]).`);
    } else if (!label) {
      parts.push('The request reached the server, but TraceNaut could not tell which route handled it.');
    } else if (mode === 'observed') {
      parts.push(`${framework}${e.service ? ` (on [[Node.js|nodejs]])` : ''} matched the request to the [[route|route]] ${label} and ran its code.`);
    } else {
      parts.push(`On the server, ${framework}${e.service ? ` (running on [[Node.js|nodejs]])` : ''} has a [[route|route]] for ${label}, so it hands the request to that route's code.`);
      if (record?.framework === 'next') parts.push(`Next.js made this route from where the file sits: ${file} ([[file-based routing|file-routing]]).`);
      if (e.middleware.length) {
        const mw = e.middleware.map((m) => (m.library ? `${m.label}${libraryMiddleware(m.label)}` : `${m.label} (this app's own code)`));
        parts.push(`Before that, ${list(mw)} ${e.middleware.length > 1 ? 'run' : 'runs'} as [[middleware|middleware]].`);
      }
    }
    return {
      type: 'server-entry',
      zone: 'server',
      title: mode === 'observed' ? 'The server received it' : 'The server receives it',
      subtitle: e.serverAction ? `Server Action ${e.serverAction}()` : page ? `${record!.path} page` : label ? `${label} route` : 'route not identified',
      summary: parts.join(' '),
      evidence: e.evidence,
      evidenceNote:
        e.evidence === 'inferred'
          ? 'Matched by comparing the request’s method and address with the routes in the server code. Watch it happen to confirm.'
          : undefined,
      tech,
      functions: [],
      facts: [
        { label: page ? 'Page' : 'Route', value: label ?? 'not identified', evidence: label ? e.evidence : 'unresolved' },
        ...(file ? [{ label: 'Defined in', value: file.split('/').pop()! }] : []),
        ...(e.middleware.length ? [{ label: 'Runs first', value: list(e.middleware.map((m) => m.label)) }] : []),
      ],
      code: e.node ? [{ nodeId: e.node.id, label: 'The route definition' }] : [],
      keys: e.node ? [`route:${e.node.id}`] : [],
      middleware: e.middleware.length ? e.middleware.map((m) => m.label) : undefined,
    };
  }

  private unknownServerStep(e: RouteEvt, mode: 'static' | 'observed'): Omit<FlowStep, 'id'> {
    return {
      type: 'unknown',
      zone: 'server',
      title: "Where it goes on the server can't be told",
      summary: `${e.missing}${mode === 'static' ? ' Watch it happen to see where it really goes.' : ''}`,
      evidence: 'unresolved',
      evidenceNote: e.missing,
      tech: [],
      functions: [],
      facts: [],
      code: [],
      keys: [],
    };
  }

  private unknownStep(label: string, note: string): Omit<FlowStep, 'id'> {
    return {
      type: 'unknown',
      zone: 'browser',
      title: `TraceNaut can't follow ${label}`,
      summary: `${capital(note)}.`,
      evidence: 'unresolved',
      evidenceNote: note,
      tech: [],
      functions: [],
      facts: [],
      code: [],
      keys: [],
    };
  }

  private databaseStep(all: SqlEvt[], mode: 'static' | 'observed'): Omit<FlowStep, 'id'> {
    // Catalog lookups a database library makes for itself (types, schema) are not the app's
    // own queries; they are mentioned, not listed as what the app reads.
    const internalSql = all.filter((s) => INTERNAL_SQL.test(s.text));
    const sql = internalSql.length < all.length ? all.filter((s) => !internalSql.includes(s)) : all;
    const service = sql.find((s) => s.service)?.service;
    // Observed on the wire, the protocol itself says which database answered.
    const wireDb = sql.find((s) => s.protocol)?.protocol;
    const db = wireDb ? { engine: fromRegistry(PROTOCOL_TECH[wireDb], `statements were observed on a ${PROTOCOL_NAME[wireDb]} connection`, 'stores the data and answers the queries')!, driver: undefined } : service ? this.tech.database(service) : undefined;
    const docs = sql.filter((s) => s.protocol === 'mongodb' || s.protocol === 'redis');
    const raw = sql.filter((s) => !s.orm && !docs.includes(s));
    const orm = sql.filter((s) => s.orm);
    const files = [...new Set(raw.map((s) => s.node?.source?.file.split('/').pop()).filter(Boolean))];
    const tech: TechRef[] = [];
    if (raw.length) tech.push(this.tech.sql(mode === 'observed' ? 'the statements were observed running' : `statements written as SQL text in ${files.join(', ')}`));
    if (orm.length) tech.push(this.tech.prisma(`model calls such as ${orm[0].text}() in ${orm[0].node?.source?.file.split('/').pop() ?? 'the server code'}`));
    if (db) tech.push(db.engine);
    if (db?.driver) tech.push(db.driver);
    const access = (s: SqlEvt) => (s.orm ? s.orm.access : s.protocol === 'mongodb' || s.protocol === 'redis' ? commandAccess(s) : opOf(s.text) === 'SELECT' ? 'read' : 'write');
    const reads = sql.every((s) => access(s) === 'read');
    const writes = sql.every((s) => access(s) === 'write');
    const engine = db ? `[[${db.engine.name}|${db.engine.id}]] ` : '';
    const driver = db?.driver ? ` through [[${db.driver.name}|${db.driver.id}]]` : '';
    const parts: string[] = [];
    if (raw.length)
      parts.push(
        mode === 'observed'
          ? `The server ran ${raw.length} [[SQL|sql]] statement${raw.length > 1 ? 's' : ''} against the ${engine}database${driver}.`
          : `The server sends ${raw.length} [[SQL|sql]] statement${raw.length > 1 ? 's' : ''} to the ${engine}database${driver}.`,
      );
    if (docs.length) {
      const name = docs[0].protocol === 'mongodb' ? '[[MongoDB|mongodb]]' : '[[Redis|redis]]';
      parts.push(
        `The server ${mode === 'observed' ? 'sent' : 'sends'} ${docs.length} command${docs.length > 1 ? 's' : ''} to ${name}: ${list([...new Set(docs.map((s) => phraseOf(s)))])}. TraceNaut reads only the command and the collection, never the data.`,
      );
    }
    const late = sql.filter((s) => s.evidence === 'inferred' && !s.orm).length;
    if (mode === 'observed' && late)
      parts.push(
        `${late === sql.length ? 'These were' : `${late} of these were`} sent by the database library a moment after the request's own code had moved on (from its queue), so ${late === 1 ? 'it is' : 'they are'} probably part of this request, but the library could have sent ${late === 1 ? 'it' : 'them'} for another one at the same time.`,
      );
    if (orm.length) {
      const models = [...new Set(orm.map((s) => s.orm!.model))];
      parts.push(
        `The server asks [[Prisma|prisma]] to ${list([...new Set(orm.map((s) => phraseOf(s)))])}. Prisma writes the [[SQL|sql]] for these calls when they run, so the exact statements are only visible in a recording.`,
      );
      if (orm.some((s) => s.evidence === 'inferred'))
        parts.push(`${list(models)} ${models.length > 1 ? 'are models' : 'is a model'} declared in ${orm[0].orm!.schemaFile}; the generated Prisma client was not available, so the link rests on the names matching.`);
    }
    if (raw.some((s) => s.text.includes('?'))) parts.push('The [[?|sql-placeholder]] marks are filled with real values only when a statement runs; TraceNaut never records those values.');
    if (internalSql.length && sql !== all) parts.push(`The database library also made ${internalSql.length === 1 ? 'a lookup' : `${internalSql.length} lookups`} of its own (type information from the database's catalog), which ${internalSql.length === 1 ? 'is' : 'are'} not part of the app's code.`);
    return {
      type: 'database',
      zone: 'database',
      title: `${reads ? 'Reads from' : writes ? 'Writes to' : 'Reads and writes data in'} ${wireDb === 'redis' ? 'Redis' : 'the database'}`,
      subtitle: sql.map((s) => phraseOf(s)).filter((v, i, a) => a.indexOf(v) === i).join(' · '),
      summary: parts.join(' '),
      evidence: sql.every((s) => s.evidence === 'inferred') ? 'inferred' : mode === 'observed' ? 'runtime' : 'static',
      tech,
      functions: [],
      facts: sql.map((s) => ({
        label: `${capital(phraseOf(s))}${s.rows !== undefined ? ` (${s.rows} row${s.rows === 1 ? '' : 's'})` : ''}`,
        value: s.orm ? `${s.orm.lib}: ${s.text}()` : s.text.trim().replace(/\s+/g, ' '),
        evidence: s.evidence,
      })),
      code: sql.filter((s) => s.node).slice(0, 4).map((s) => ({ nodeId: s.node!.id, label: `${capital(phraseOf(s))} (in ${s.owner})` })),
      // Recorded SQL has its string literals replaced; static text is normalised the same way to compare.
      keys: sql.map((s) => (s.orm ? `orm:${s.text}` : `sql:${s.text.replace(/'(?:[^']|'')*'/g, "'…'").replace(/\s+/g, ' ').trim()}`)),
    };
  }

  private responseStep(e: RespEvt, req: ReqEvt | undefined, mode: 'static' | 'observed'): Omit<FlowStep, 'id'> {
    const parts: string[] = [];
    const facts: FlowFact[] = [];
    const json = e.outcomes.some((o) => o.sends);
    if (mode === 'observed' && e.status) {
      parts.push(`The server answered with [[status code|status-code]] ${e.status} ${statusText(e.status)}.`);
      facts.push({ label: 'Status', value: `${e.status} ${statusText(e.status)}`, evidence: 'runtime' });
    } else if (e.outcomes.length) {
      parts.push(`The server sends an [[HTTP|http]] response back, with a [[status code|status-code]] saying how it went. The answers written in the code are listed below; which one happens depends on the request.`);
      const seen = new Set<string>();
      for (const o of e.outcomes) {
        const key = `${o.status}|${o.sends?.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({
          label: o.status === '?' ? 'Status set at runtime' : `${o.status} ${statusText(o.status)}`,
          value: `${o.sends ? (o.sends.length ? `sends ${list(o.sends)}` : 'sends an empty body') : 'no body'}${o.role === 'middleware' ? ` (from ${o.from}, before the route runs)` : ''}`,
          evidence: 'static',
        });
      }
    } else if (e.serverAction) {
      parts.push(`When ${e.serverAction}() finishes, the server sends its result back to the page${e.redirectTo ? `, and tells the browser to go to ${e.redirectTo}` : ''}.`);
    } else if (e.routeId && this.a.routeById(e.routeId)?.kind === 'page') {
      parts.push('The server sends back the page it rendered: HTML when the page is opened, or a [[React Server Components|server-component]] payload when the app moves to it by itself.');
    } else {
      parts.push("TraceNaut found no explicit answer in the route's code.");
    }
    for (const c of e.cookies) parts.push(`It also ${c.action} a [[cookie|session-cookie]] named ${c.name}.`);
    const tech: TechRef[] = [this.tech.http(mode === 'observed' ? 'the response was observed arriving in the browser' : "the route's code writes the answer and its status code")];
    if (json) tech.push(this.tech.json("the route's code sends its answer as JSON"));
    const statuses = mode === 'observed' && e.status ? [e.status] : [...new Set(e.outcomes.map((o) => o.status))];
    return {
      type: 'response',
      zone: 'network',
      title: mode === 'observed' ? 'The server answered' : 'The server answers',
      subtitle:
        statuses.map((s) => (s === '?' ? 'status set at runtime' : `${s} ${statusText(s)}`)).join(' · ') ||
        (e.serverAction ? (e.redirectTo ? `result, then go to ${e.redirectTo}` : 'the action\'s result') : undefined),
      summary: parts.join(' '),
      evidence: e.evidence,
      tech,
      functions: [],
      facts,
      code: e.handlerId ? [{ nodeId: e.handlerId, label: 'Where the answers are written' }] : e.routeId ? [{ nodeId: e.routeId, label: 'The route' }] : [],
      keys: e.routeId ? [`route:${e.routeId}:response`] : req ? [`resp:${req.method} ${req.path}`] : [],
      observed: mode === 'observed' ? { status: e.status } : undefined,
      branches: statuses.length > 1 ? statuses.map((s) => ({ status: s, label: s === '?' ? 'set at runtime' : `${s} ${statusText(s)}` })) : undefined,
    };
  }

  /** The code changes the page through a router or the browser's location. */
  private navigationStep(e: NavEvt): Omit<FlowStep, 'id'> {
    const next = e.router.startsWith('Next.js');
    const to = e.to ?? 'an address the code computes when it runs';
    const parts = [
      `${e.owner}() changes the page to ${to} using the ${e.router}.`,
      next
        ? 'Next.js swaps the page without a full reload: the browser asks the server for the new page, its [[Server Components|server-component]] run there (often reading the database), and the result replaces what is on screen.'
        : e.router === 'React Router'
          ? 'React Router shows the screen for that address without reloading the page; that screen\'s components then draw.'
          : 'The browser loads that address as a new page.',
    ];
    if (!e.to) parts.push('Which page it is depends on values only known when the code runs (for example what was typed).');
    return {
      type: 'navigation',
      zone: 'browser',
      title: next ? 'Changes the page (Next.js router)' : e.router === 'React Router' ? 'Changes the screen (React Router)' : 'Goes to another page',
      subtitle: e.to ?? 'address computed at runtime',
      summary: parts.join(' '),
      evidence: 'static',
      tech: [next ? fromRegistry('nextjs', `${e.owner}() calls Next.js's router`, 'changes pages without a full reload') : e.router === 'React Router' ? fromRegistry('remix', `${e.owner}() calls React Router's navigate`, 'changes screens without a reload') : undefined].filter((t): t is TechRef => !!t),
      functions: [],
      facts: [
        { label: 'Router', value: e.router },
        { label: 'Goes to', value: to },
      ],
      code: [],
      keys: [`nav:${e.to ?? '?'}`],
    };
  }

  /** Statements a server ran during the recording that could not be linked to any request. */
  private unattributedStep(items: NonNullable<TraceResult['unattributed']>): Omit<FlowStep, 'id'> {
    const sql = items.map((i) => this.observedSql(i.sql, 'the server', i.service));
    const base = this.databaseStep(sql, 'observed');
    return {
      ...base,
      title: 'Also ran in the database during the recording',
      summary: `TraceNaut saw ${sql.length === 1 ? 'this statement' : `these ${sql.length} statements`} on the server while recording, but cannot tell which request sent ${sql.length === 1 ? 'it' : 'them'}: the database library sent ${sql.length === 1 ? 'it' : 'them'} from its own queue. ${sql.length === 1 ? 'It' : 'They'} may belong to your action, or to something else running at the same time.`,
      evidence: 'unresolved',
      evidenceNote: 'Seen running, but not linked to a request.',
      incidental: true,
      keys: [],
    };
  }

  /** A request that was sent but never answered: aborted by the page, or a network failure. */
  private noAnswerStep(error: string): Omit<FlowStep, 'id'> {
    const aborted = /abort/i.test(error);
    return {
      type: 'response',
      zone: 'network',
      title: 'No answer came back',
      subtitle: aborted ? 'cancelled' : 'failed',
      summary: aborted
        ? 'The page cancelled the request before an answer arrived (it was aborted), so there is no [[status code|status-code]].'
        : `The request did not get an answer: ${error}. That can mean the server was not reachable or the connection broke.`,
      evidence: 'runtime',
      tech: [this.tech.http('the request was observed leaving the browser')],
      functions: [],
      facts: [{ label: 'What the browser reported', value: error, evidence: 'runtime' }],
      code: [],
      keys: [],
    };
  }

  private uiUpdateStep(states: string[], renders: { node: GraphNode; count: number }[], mode: 'static' | 'observed', req?: InspectRequest): Omit<FlowStep, 'id'> {
    void req;
    const parts: string[] = [];
    if (mode === 'observed') {
      parts.push(`React [[re-rendered|render]] ${list(renders.map((r) => r.node.label))}: it ran these components again to redraw the parts of the page that changed.`);
    } else {
      parts.push(`Back in the browser, the code stores new values in React [[state|state]] (${list([...new Set(states)])}). When state changes, React [[re-renders|render]] the components that use it, so the screen shows the result.`);
    }
    const renderFile = renders[0]?.node.source?.file;
    const tech = renderFile ? this.tech.libraries(renderFile).filter((t) => t.id === 'react') : [];
    return {
      type: 'ui-update',
      zone: 'browser',
      title: mode === 'observed' ? 'The page redrew' : 'The page updates',
      subtitle: mode === 'observed' ? renders.map((r) => `${r.node.label}${r.count > 1 ? ` ×${r.count}` : ''}`).join(' · ') : [...new Set(states)].join(' · '),
      summary: parts.join(' '),
      evidence: mode === 'observed' ? 'runtime' : 'static',
      tech: tech.length ? tech.map((t) => ({ ...t, role: 'redraws components when their state changes' })) : [],
      functions: renders.map((r) => ({ node: r.node, params: [], evidence: 'runtime' as const, ran: true, note: `rendered ${r.count}×` })),
      facts: mode === 'observed' ? renders.map((r) => ({ label: r.node.label, value: `redrawn ${r.count} time${r.count > 1 ? 's' : ''}`, evidence: 'runtime' as const })) : [],
      code: renders.slice(0, 3).filter((r) => r.node.expandable).map((r) => ({ nodeId: r.node.id, label: `${r.node.label} component` })),
      keys: ['ui-update'],
    };
  }

  // ======================================================================== helpers

  private overview(steps: FlowStep[], req: InspectRequest | undefined, mode: 'static' | 'observed', handler?: HandlerInfo): string {
    const parts: string[] = [];
    const first = steps[0];
    if (mode === 'static' && req && handler) {
      const verb = verbFor(req.element);
      if ((handler.event === 'onSubmit' || handler.event === 'action') && handler.via) parts.push(`${capital(verb.ing)} ${describeTarget(req.element)} submits its form.`);
      else parts.push(`${capital(verb.ing)} ${describeTarget(req.element)} runs its “${eventName(handler.event)}” handler.`);
    } else if (first) parts.push(`${first.title}.`);
    for (const s of steps) {
      if (s.type === 'request') parts.push(`${mode === 'static' ? 'The browser then sends' : 'The browser sent'} a ${s.subtitle} request${s.facts.find((f) => f.label === 'Sends' && !/nothing|not determined/.test(f.value)) ? ` with ${s.facts.find((f) => f.label === 'Sends')!.value}` : ''}.`);
      if (s.type === 'database') parts.push(`On the server, the code ${mode === 'static' ? 'asks' : 'asked'} the database to ${list((s.subtitle ?? '').split(' · '))}.`);
      if (s.type === 'response') parts.push(`The server ${mode === 'static' ? 'answers' : 'answered'}${s.subtitle ? ` (${s.subtitle})` : ''}.`);
      if (s.type === 'unknown' && s.zone === 'server') parts.push("Where it goes on the server can't be told from here.");
      if (s.type === 'ui-update') parts.push(mode === 'static' ? 'Then the page updates.' : 'Then the page redrew.');
    }
    if (parts.length === 1 && steps.length > 1) parts.push(mode === 'static' ? 'Its code runs in the browser and does not contact a server.' : 'Only browser code ran; no request was sent.');
    return parts.join(' ');
  }

  /** One sentence that answers the question; the rest of the journey adds detail. */
  private headline(steps: FlowStep[], el: InspectRequest['element'], mode: 'static' | 'observed', handler?: HandlerInfo): string {
    // Requests the browser sent (not those a server made while handling one).
    const requests = steps.filter((s) => s.type === 'request' && !s.fromServer && !s.keys[0]?.startsWith('ws:'));
    if (mode === 'observed') {
      const first = requests[0];
      if (!first) return 'Only code in the browser ran; nothing was sent to a server.';
      // The answer to this request, not to a request the server made while handling it.
      let depth = 0;
      let answer: string | undefined;
      for (const s of steps.slice(steps.indexOf(first))) {
        if (s.type === 'request') depth++;
        else if (s.type === 'response' && --depth === 0) {
          answer = s.subtitle;
          break;
        }
      }
      const more = requests.length > 1 ? `, then ${requests.length - 1} more request${requests.length > 2 ? 's' : ''} followed` : '';
      // The headline names the address without its query string; the step shows it in full.
      const sent = first.subtitle?.replace(/\?.*$/, '');
      const tail = `${answer ? ` and the server answered ${answer}` : ''}${more}.`;
      // Say only as much about cause as the recording shows: the code that sent the first
      // request ran either because of the event, after the redraw (an effect), or just later.
      const before = steps.slice(0, steps.indexOf(first)).reverse().find((s) => s.type === 'ui-logic' || s.type === 'client-logic');
      if (before?.title.startsWith('After the redraw')) return `After the page redrew, it sent ${sent}${tail}`;
      if (before?.title.startsWith('A moment later')) return `A moment later, the code your action scheduled sent ${sent}${tail}`;
      if (before?.title.startsWith('Also ran')) return `While recording, the browser sent ${sent}${tail} TraceNaut can't tell whether your action caused it.`;
      return `The browser sent ${sent}${tail}`;
    }
    const verb = capital(verbFor(el).ing);
    const how = (handler?.event === 'onSubmit' || handler?.event === 'action') && handler.via ? 'submits its form' : handler?.event === 'action' ? 'runs its form action' : `runs its “${eventName(handler?.event ?? 'onClick')}” handler`;
    const first = requests[0];
    if (!first) {
      const navs = steps.filter((s) => s.type === 'navigation');
      if (navs.length > 1) return `${verb} it ${how}, which then changes the page; where to depends on what happens when it runs.`;
      const nav = navs[0];
      if (nav) return `${verb} it ${how}, which changes the page${nav.subtitle && !nav.subtitle.includes('runtime') ? ` to ${nav.subtitle}` : ''}.`;
      // Only claim the code stays in the browser when nothing on the way was left unfollowed.
      if (steps.some((s) => s.type === 'unknown' || s.evidence === 'unresolved')) return `${verb} it ${how}; TraceNaut cannot follow all of what happens next.`;
      return `${verb} it ${how}; the code stays in the browser.`;
    }
    const sends = first.facts.find((f) => f.label === 'Sends')?.value;
    const what = sends && !/nothing|not determined/.test(sends) ? `sends ${sends} to the server` : `sends a ${first.subtitle?.split(' ')[0] ?? ''} request to the server`;
    return `${verb} it ${how} and ${what}.`;
  }

  private contextLine(inspect: InspectResult) {
    const lvl = inspect.levels[inspect.primary] ?? inspect.levels[0];
    return lvl?.owner ? `Part of the ${lvl.owner.label} component` : undefined;
  }

  private zoneOf(node: GraphNode): 'browser' | 'server' {
    const svc = this.a.ws.services.find((s) => s.name === node.source?.service);
    return svc?.kind === 'node' ? 'server' : 'browser';
  }

  private sqlText(node: GraphNode): string {
    const t = this.a.sqlTextAt(node.id);
    return t ?? node.label;
  }
}

const BACKEND_FRAMEWORKS = new Set(['express', 'fastify', 'hono', 'koa', 'nestjs', 'nextjs']);
const ROUTE_FRAMEWORK_TECH: Record<string, string> = { express: 'express', fastify: 'fastify', hono: 'hono', 'koa-router': 'koa', next: 'nextjs' };

// ---------------------------------------------------------------------------- text helpers

function callSignature(c: TraceCall): string {
  return `${c.probe}(${c.children.map(callSignature).join(',')};${c.requests.map((r) => `${r.method} ${r.url}`).join(',')})`;
}

function eventName(prop: string) {
  return prop.replace(/^on/, '').toLowerCase();
}

function verbFor(el: { tag: string; attributes: Record<string, string> }) {
  const type = (el.attributes.type ?? '').toLowerCase();
  if (el.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'image'].includes(type)) return { present: 'type into', past: 'typed into', ing: 'typing into' };
  if (el.tag === 'textarea') return { present: 'type into', past: 'typed into', ing: 'typing into' };
  if (el.tag === 'select') return { present: 'choose from', past: 'chose from', ing: 'choosing from' };
  return { present: 'click', past: 'clicked', ing: 'clicking' };
}

function describeTarget(el: { tag: string; text: string; attributes: Record<string, string> }) {
  const label = el.text || el.attributes['aria-label'] || el.attributes.placeholder || el.attributes.name;
  return label ? `“${trim(label, 32)}”` : `the <${el.tag}>`;
}

function trim(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function list(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Anonymous callbacks get a description of where they are, instead of a synthetic name. */
export function friendlyName(label: string) {
  const route = /^(get|post|put|patch|delete|all)\('([^']*)'\) callback$/.exec(label);
  if (route) return `route code (${route[1].toUpperCase()} ${route[2]})`;
  if (label === 'useEffect callback') return 'effect';
  const handler = /^on([A-Z]\w*) handler$/.exec(label);
  if (handler) return `${handler[1].toLowerCase()} handler`;
  return label;
}

function chain(labels: string[]) {
  const shown = labels.slice(0, 4).join(' → ');
  return labels.length > 4 ? `${shown} → +${labels.length - 4}` : shown;
}

function placeholders(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

const STATUS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other (go to another page)',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable',
  500: 'Server Error',
};
function statusText(s: number | '?') {
  return s === '?' ? '' : (STATUS[s] ?? '');
}

/** Queries database libraries make about the database itself (types, schema), not app data. */
const INTERNAL_SQL = /\b(pg_catalog|information_schema)\.|^\s*(show\s+\w+|select\s+version\(\))/i;

const PROTOCOL_TECH = { postgres: 'postgresql', mysql: 'mysql', mongodb: 'mongodb', redis: 'redis' } as const;
const PROTOCOL_NAME = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', redis: 'Redis' } as const;

/** MongoDB commands and Redis commands that only read. */
const READ_COMMANDS = /^(find|aggregate|count|countDocuments|distinct|listCollections|listIndexes|GET|MGET|HGET|HGETALL|HMGET|EXISTS|TTL|PTTL|KEYS|SCAN|SMEMBERS|SISMEMBER|ZRANGE|ZRANGEBYSCORE|ZSCORE|LRANGE|LLEN|SCARD|ZCARD|STRLEN|TYPE)$/;

function commandAccess(s: SqlEvt): 'read' | 'write' {
  return READ_COMMANDS.test(s.text.split(' ')[0]) ? 'read' : 'write';
}

function phraseOf(s: SqlEvt) {
  if (s.orm) return ormPhrase(s.orm);
  if (s.protocol === 'mongodb') {
    const [cmd, coll = 'data'] = s.text.split(' ');
    return `${commandAccess(s) === 'read' ? 'read' : /^insert/.test(cmd) ? 'add to' : /^delete/.test(cmd) ? 'remove from' : 'change'} ${coll}`;
  }
  if (s.protocol === 'redis') return `${commandAccess(s) === 'read' ? 'read' : 'write'} a key (${s.text})`;
  return opPhrase(s.text);
}

function opOf(sql: string) {
  return sql.trim().split(/\s+/)[0].toUpperCase();
}

function opPhrase(sql: string) {
  const tables = sqlTables(sql);
  const t = tables.length ? tables.join(', ') : 'data';
  switch (opOf(sql)) {
    case 'SELECT':
      return `read ${t}`;
    case 'INSERT':
      return `add to ${t}`;
    case 'UPDATE':
      return `change ${t}`;
    case 'DELETE':
      return `remove from ${t}`;
    case 'CREATE':
      return `create ${t}`;
    default:
      return `run SQL on ${t}`;
  }
}

function dbClause(sql: SqlEvt[]) {
  const phrases = [...new Set(sql.map((s) => opPhrase(s.text)))];
  return phrases.length ? list(phrases) : '';
}

function libraryMiddleware(label: string) {
  const known: Record<string, string> = {
    'express.json()': ' (reads the JSON body)',
    'express.urlencoded()': ' (reads form data)',
    'express.static()': ' (serves files)',
  };
  return known[label] ?? ' (from a library)';
}
