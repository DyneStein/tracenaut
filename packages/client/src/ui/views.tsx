import { useEffect, useState } from 'preact/hooks';
import type { HandlerInfo, InspectRequest, InspectResult, JourneyResult, StackResult, StackTech, TechRef, TraceCall, TraceRequest, TraceResult } from '@tracenaut/protocol';
import { TechChip } from './journey.js';
import { api } from '../api.js';
import { Icon3D } from './icon3d.js';
import type { ElementSnapshot } from '../adapters.js';
import type { RecorderState } from '../runtime.js';
import { Badge, CodeBlock, ErrorBox, Icon, KindIcon, Loading, Loc, NodeLink, Notes, RelationList, useAsync, useNav } from './common.js';

// =============================================================== element

export interface ElementEntry {
  request: InspectRequest;
  result: Promise<InspectResult>;
  journey: Promise<JourneyResult>;
  el: WeakRef<Element>;
  snap: ElementSnapshot;
  /** Ask the daemon again (after a failure). */
  reload: () => void;
}

export function ElementView({ entry, highlight }: { entry: ElementEntry; highlight: (el?: Element) => void }) {
  const state = useAsync(() => entry.result, [entry]);
  const [level, setLevel] = useState<number | null>(null);
  const { request } = entry;

  if (state.loading) return <Loading />;
  if (state.error)
    return (
      <ErrorBox
        message={state.error}
        onRetry={
          state.canRetry
            ? () => {
                entry.reload();
                state.retry();
              }
            : undefined
        }
      />
    );
  const result = state.data!;
  const selected = level ?? result.primary;
  const lvl = result.levels[selected];
  const crumbs = result.levels.map((l, i) => ({ l, i })).filter(({ l, i }) => l.entry.type === 'component' || i === 0);

  return (
    <>
      <div class="section" onMouseEnter={() => highlight(entry.el.deref())} onMouseLeave={() => highlight()}>
        <div class="title-row">
          <KindIcon kind="element" />
          <div style="min-width:0">
            <div class="title">
              <span class="tag">&lt;{request.element.tag}&gt;</span>{' '}
              {request.element.text ? <span class="text-preview">“{request.element.text}”</span> : null}
            </div>
            <div class="subtitle">
              {result.levels.length
                ? `Rendered by ${result.levels[0].owner?.label ?? 'unknown'} · located through ${request.adapter === 'react' ? 'the React fiber tree' : 'DOM attributes'}`
                : 'No source location found'}
            </div>
          </div>
        </div>
        {crumbs.length > 1 ? (
          <div class="crumbs" aria-label="Component ancestry (outermost first)">
            {crumbs
              .slice()
              .reverse()
              .map(({ l, i }, n) => (
                <>
                  {n > 0 ? <span class="crumb-sep">›</span> : null}
                  <button class={`crumb${i === selected ? ' on' : ''}`} onClick={() => setLevel(i)} title={l.source ? `${l.source.file}:${l.source.line}` : l.error}>
                    {l.entry.type === 'component' ? (l.tag ?? l.entry.name) : `<${l.tag ?? l.entry.name}>`}
                  </button>
                </>
              ))}
          </div>
        ) : null}
      </div>

      {lvl ? <LevelSource result={result} index={selected} /> : null}

      <div class="section">
        <div class="section-title">
          When you interact <span class="count">{result.handlers.length ? `· ${result.handlers.length}` : ''}</span>
        </div>
        {result.handlers.map((h) => (
          <HandlerCard key={`${h.event}|${h.attachedAt.file}:${h.attachedAt.line}`} handler={h} />
        ))}
        <Notes notes={result.notes} />
      </div>
    </>
  );
}

function LevelSource({ result, index }: { result: InspectResult; index: number }) {
  const lvl = result.levels[index];
  const id = lvl.source ? `jsx:${lvl.entry.loc}` : undefined;
  const detail = useAsync(() => (id ? api.node(id) : Promise.reject(new Error(lvl.error ?? 'No source'))), [id]);
  return (
    <div class="section">
      <div class="section-title">
        {lvl.entry.type === 'component' ? `<${lvl.tag ?? lvl.entry.name}> usage` : `<${lvl.tag ?? lvl.entry.name}> element`}
        {lvl.owner ? (
          <span class="count">
            · in <NodeLink node={lvl.owner} />
          </span>
        ) : null}
        {lvl.definition && lvl.definition.kind !== 'unresolved' ? (
          <span class="count">
            · defined by <NodeLink node={lvl.definition} />
          </span>
        ) : null}
      </div>
      {detail.loading ? <Loading label="Loading source…" /> : detail.error ? <div class="error">{detail.error}</div> : detail.data!.code ? <CodeBlock code={detail.data!.code} /> : null}
    </div>
  );
}

function HandlerCard({ handler: h }: { handler: HandlerInfo }) {
  return (
    <div class="handler">
      <div class="handler-head">
        <span class="event">{h.event}</span>
        <span class="handler-where">
          on <code>{h.attachedTo}</code> <Loc source={h.attachedAt} />
          {h.via ? ` · ${h.via}` : ''}
        </span>
        {h.runtimeAttached ? (
          <span class="ok" title="The live React props hold a function for this handler right now.">● attached now</span>
        ) : (
          <span class="warn" title="Not observed as a live prop (static JSX only, or not attached in the current render).">○ not confirmed live</span>
        )}
      </div>
      {h.hops.length ? (
        <ul class="hops">
          {h.hops.map((hop) => (
            <li key={hop}>{hop}</li>
          ))}
        </ul>
      ) : null}
      <RelationList relations={[h.relation]} />
    </div>
  );
}

// =============================================================== node

export function NodeView({ id }: { id: string }) {
  const state = useAsync(() => api.node(id), [id]);
  const [callers, setCallers] = useState<Awaited<ReturnType<typeof api.callers>> | null>(null);
  const [callersError, setCallersError] = useState<string>();
  useEffect(() => {
    setCallers(null);
    setCallersError(undefined);
  }, [id]);

  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.canRetry ? state.retry : undefined} />;
  const d = state.data!;
  const isFn = ['function', 'component', 'hook', 'method'].includes(d.node.kind);
  return (
    <>
      <div class="section">
        <div class="title-row">
          <KindIcon kind={d.node.kind} />
          <div style="min-width:0">
            <div class="title">{d.node.label}</div>
            <div class="subtitle">
              {d.node.detail ? `${d.node.detail} · ` : ''}
              {d.node.source ? `${d.node.source.file}:${d.node.source.line}` : ''}
            </div>
          </div>
        </div>
        {d.facts.length ? (
          <dl class="facts">
            {d.facts.map((f) => (
              <>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </>
            ))}
          </dl>
        ) : null}
      </div>
      {d.code ? (
        <div class="section">
          <CodeBlock code={d.code} />
        </div>
      ) : null}
      {d.relations.length ? (
        <div class="section">
          <div class="section-title">
            {relationsTitle(d.node.kind)} <span class="count">· {d.relations.length}</span>
          </div>
          <RelationList relations={d.relations} seen={new Set([d.node.id])} />
        </div>
      ) : null}
      {isFn ? (
        <div class="section">
          <div class="section-title">Used by</div>
          {callers ? (
            callers.length ? <RelationList relations={callers} /> : <Notes notes={['No references found in the analysed services.']} />
          ) : callersError ? (
            <div class="error">{callersError}</div>
          ) : (
            <button class="link-btn" onClick={() => api.callers(id).then(setCallers, (e) => setCallersError(String(e.message)))}>
              Find what calls this
            </button>
          )}
        </div>
      ) : null}
      {d.notes.length ? (
        <div class="section">
          <Notes notes={d.notes} />
        </div>
      ) : null}
    </>
  );
}

function relationsTitle(kind: string) {
  if (kind === 'http-request') return 'Handled by';
  if (kind === 'http-route') return 'Runs';
  if (kind === 'element') return 'Relationships';
  if (kind === 'class') return 'Members';
  return 'Calls & uses';
}

// =============================================================== trace

export function TraceView({ state, result, error, onCancel }: { state: RecorderState; result?: TraceResult; error?: string; onCancel: () => void }) {
  if (error) return <div class="error">{error}</div>;
  if (!result) {
    if (state.phase === 'armed') {
      return (
        <div class="armed">
          <div class="rec">Watching for your next action</div>
          <p>Use the page normally. Your next click, keypress or form submission is recorded until things settle.</p>
          <button class="link-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      );
    }
    if (state.phase === 'recording') return <Loading label={`Recording… ${state.calls} calls, ${state.requests} requests`} />;
    return <Loading label="Assembling the trace…" />;
  }
  return <TraceResultView result={result} />;
}

function TraceResultView({ result }: { result: TraceResult }) {
  const nothing = result.calls.length === 0 && result.orphanRequests.length === 0;
  return (
    <>
      <div class="section">
        <div class="title-row">
          <KindIcon kind="element" />
          <div style="min-width:0">
            <div class="title">
              {result.action ? (
                <>
                  {result.action.type} on <span class="tag">&lt;{result.action.tag}&gt;</span>
                  {result.action.text ? <span class="text-preview"> “{result.action.text}”</span> : null}
                </>
              ) : (
                'No interaction'
              )}
            </div>
            <div class="subtitle">
              {result.durationMs} ms recorded · <Badge evidence="runtime" /> everything below was observed
            </div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">What ran</div>
        {nothing ? <Notes notes={['No instrumented function ran and no request was made. The interaction may be handled entirely by the browser or by library code.']} /> : null}
        <ul class="tree">
          {result.calls.map((c, i) => (
            <CallRow key={`${c.probe}-${i}`} call={c} defaultOpen />
          ))}
        </ul>
        {result.orphanRequests.map((r, i) => (
          <RequestBox key={i} req={r} />
        ))}
      </div>
      {result.renders.length ? (
        <div class="section">
          <div class="section-title">Re-rendered</div>
          <div class="renders">
            {result.renders.map((r) => (
              <RenderChip key={r.node.id} node={r.node} count={r.count} />
            ))}
          </div>
        </div>
      ) : null}
      {result.notes.length ? (
        <div class="section">
          <Notes notes={result.notes} />
        </div>
      ) : null}
    </>
  );
}

function RenderChip({ node, count }: { node: TraceResult['renders'][number]['node']; count: number }) {
  const nav = useNav();
  return (
    <button class="chip btn" onClick={() => node.expandable && nav.open({ kind: 'node', id: node.id })} title="Component function executed (render)">
      {node.label} ×{count}
    </button>
  );
}

function CallRow({ call, defaultOpen = false }: { call: TraceCall; defaultOpen?: boolean }) {
  const nav = useNav();
  const [open, setOpen] = useState(defaultOpen || call.children.length + call.requests.length + call.sql.length <= 6);
  const hasKids = call.children.length + call.requests.length + call.sql.length > 0;
  return (
    <li>
      <div class="row">
        <button class={`chev${open ? ' open' : ''}${hasKids ? '' : ' none'}`} onClick={() => setOpen(!open)} aria-label="Toggle">
          {Icon.chev({ size: 12 })}
        </button>
        <KindIcon kind={call.node.kind} />
        <button class="row-main" onClick={() => call.node.expandable && nav.open({ kind: 'node', id: call.node.id })}>
          <span class={`row-label${call.node.expandable ? ' link' : ''}`}>{call.node.label}</span>
        </button>
        {call.durationMs !== undefined ? <span class="dur">{call.durationMs} ms</span> : null}
        <Loc source={call.node.source} />
      </div>
      {open && hasKids ? (
        <ul class="tree">
          {call.children.map((c, i) => (
            <CallRow key={`${c.probe}-${i}`} call={c} />
          ))}
          {call.sql.map((q, i) => (
            <li key={`q${i}`}>
              <div class="sql" title={`${q.op}() · ${q.durationMs} ms${q.rows !== undefined ? ` · ${q.rows} row(s)` : ''}`}>
                <KindIcon kind="sql" />
                <code>{q.sql.trim().replace(/\s+/g, ' ')}</code>
                <span class="dur">{q.rows !== undefined ? `${q.rows}r` : ''}</span>
              </div>
            </li>
          ))}
          {call.requests.map((r, i) => (
            <li key={`r${i}`}>
              <RequestBox req={r} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RequestBox({ req }: { req: TraceRequest }) {
  const nav = useNav();
  const statusClass = req.error ? 'err' : req.status ? `s${String(req.status)[0]}` : '';
  return (
    <div class="req">
      <div class="req-head">
        <span class="method">{req.method}</span>
        <span class="url" title={req.url}>
          {req.url}
        </span>
        <span class={`status ${statusClass}`}>{req.error ? 'failed' : (req.status ?? '…')}</span>
        {req.durationMs !== undefined ? <span class="dur">{req.durationMs} ms</span> : null}
      </div>
      {req.server ? (
        <div class="server">
          <div class="server-head">
            <span class="svc">{req.server.service}</span>
            {req.server.routeNode ? (
              <>
                matched route
                <button class="link-btn" onClick={() => nav.open({ kind: 'node', id: req.server!.routeNode!.id })}>
                  {req.server.routeNode.label}
                </button>
                <Loc source={req.server.routeNode.source} />
              </>
            ) : req.server.route ? (
              <>matched {req.server.route}</>
            ) : (
              <>no framework route reported</>
            )}
          </div>
          <ul class="tree">
            {req.server.calls.map((c, i) => (
              <CallRow key={`${c.probe}-${i}`} call={c} defaultOpen />
            ))}
          </ul>
          {req.server.sql.map((q, i) => (
            <div class="sql" key={i}>
              <KindIcon kind="sql" />
              <code>{q.sql}</code>
            </div>
          ))}
          {req.server.dropped ? <div class="row-note">{req.server.dropped} calls not recorded (limit reached)</div> : null}
        </div>
      ) : req.serverNote ? (
        <div class="server-note">Server side: {req.serverNote}</div>
      ) : null}
    </div>
  );
}

// =============================================================== home

export function HomeView({ connected, stale, technical }: { connected: boolean | undefined; stale?: boolean; technical: boolean }) {
  return (
    <>
      <HomeIntro connected={connected} technical={technical} />
      {stale ? <p class="warn home-warn">The TraceNaut daemon was restarted. Reload this page to reconnect.</p> : null}
      {connected ? <BuiltWith /> : null}
    </>
  );
}

/** Technologies the project uses (from its manifests and files), split by what TraceNaut can follow. */
function BuiltWith() {
  const [stack, setStack] = useState<StackResult | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.stack().then(setStack, () => setFailed(true));
  }, []);
  if (failed) return null;
  if (!stack) return <p class="built-with-loading">Reading the project…</p>;
  const asRef = (t: StackTech): TechRef => ({ id: t.id, name: t.name, kind: t.kind, evidence: t.evidence.join('; '), asset: t.asset, logo: t.logo, what: t.what, effect: t.effect });
  const followed = stack.techs.filter((t) => t.support.static || t.support.trace);
  const known = stack.techs.filter((t) => !followed.includes(t));
  return (
    <section class="built-with" aria-label="This project is built with">
      <h4>This project is built with</h4>
      {followed.length ? (
        <>
          <p class="bw-note">TraceNaut follows these through the code:</p>
          <div class="bw-chips">
            {followed.map((t) => (
              <TechChip key={t.id} tech={asRef(t)} />
            ))}
          </div>
        </>
      ) : null}
      {known.length ? (
        <>
          <p class="bw-note">Also used. TraceNaut recognises these but does not follow how they work:</p>
          <div class="bw-chips">
            {known.map((t) => (
              <TechChip key={t.id} tech={asRef(t)} />
            ))}
          </div>
        </>
      ) : null}
      <p class="bw-foot">
        Found by reading {stack.scanned.files} files{stack.scanned.truncated ? ' (stopped early: very large repository)' : ''}. Hover a name to see how TraceNaut knows.
      </p>
    </section>
  );
}

function HomeIntro({ connected, technical }: { connected: boolean | undefined; technical: boolean }) {
  return (
    <div class="empty">
      <div style="display:flex;justify-content:center">
        <Icon3D name="brand-mark" size={56} />
      </div>
      <h3>{technical ? 'Inspect the code behind the page' : 'See how this app works'}</h3>
      <p>
        Hold <span class="kbd">Alt</span> and right-click anything on the page, then choose <b>Inspect with TraceNaut</b>. TraceNaut explains what it
        does, step by step, from the page to the server and the database.
      </p>
      <p>
        Or press <span class="kbd">Alt</span> <span class="kbd">Shift</span> <span class="kbd">I</span> and click an element.
      </p>
      {connected === false ? <p class="warn">TraceNaut can’t reach its daemon. Start it with `tracenaut start`; this page reconnects on its own.</p> : null}
    </div>
  );
}
