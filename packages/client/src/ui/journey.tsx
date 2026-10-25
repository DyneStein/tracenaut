import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Evidence, Flow, FlowStep, TechRef, Zone } from '@tracenaut/protocol';
import { api } from '../api.js';
import type { ElementSnapshot } from '../adapters.js';
import { Rich, useExplain, plain } from '../learn/explain.js';
import { KIND_LABEL } from '../learn/concepts.js';
import { CodeBlock, Icon, useAsync, useNav } from './common.js';
import { EVIDENCE_ICON, Icon3D, STEP_ICON, ZONE_ICON } from './icon3d.js';
import { LayersView } from './layers.js';

// ------------------------------------------------------------------ certainty, in plain words

export const CERTAINTY: Record<Evidence, { word: string; help: string }> = {
  runtime: { word: 'Happened', help: 'TraceNaut saw this happen while recording.' },
  static: { word: 'In the code', help: 'Written in the source code, so it can happen. Not yet seen running.' },
  inferred: { word: 'Likely', help: 'A connection TraceNaut worked out from the code. Likely, but not proven.' },
  unresolved: { word: "Can't tell", help: "TraceNaut can't determine this from the code." },
};

export const RANK: Record<Evidence, number> = { unresolved: 0, inferred: 1, static: 2, runtime: 3 };

export function Certainty({ evidence, technical }: { evidence: Evidence; technical?: boolean }) {
  return (
    <span class={`cert ev-${evidence}`} title={CERTAINTY[evidence].help}>
      <span class="cert-dot" />
      {CERTAINTY[evidence].word}
      {technical ? <span class="cert-tech">{evidence}</span> : null}
    </span>
  );
}

export const ZONE_LABEL: Record<Exclude<Zone, 'network'>, string> = {
  browser: 'In your browser',
  server: 'On the server',
  database: 'In the database',
};

/** How sure TraceNaut is, explained once, on request (replaces a permanent legend). */
export function CertaintyGuide() {
  return (
    <ul class="cert-guide">
      {(['runtime', 'static', 'inferred', 'unresolved'] as const).map((e) => (
        <li key={e}>
          <Icon3D name={EVIDENCE_ICON[e]} size={22} />
          <b>{CERTAINTY[e].word}</b>
          <span>{CERTAINTY[e].help}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ element replica

/** A simplified drawing of the real element, made from its live styles. */
const TRANSPARENT_BG = /^(transparent|rgba\(0, 0, 0, 0\))$/;

export function ElementReplica({ snap }: { snap: ElementSnapshot }) {
  return (
    <span
      class={`replica r-${snap.kind}`}
      // A see-through element is drawn on the page colour behind it, as it appears on the page.
      style={{ background: TRANSPARENT_BG.test(snap.background) && snap.backdrop ? snap.backdrop : snap.background, color: snap.color, borderRadius: snap.radius, border: snap.border, fontWeight: snap.fontWeight }}
      title={`A simplified drawing of the <${snap.tag}> you inspected, from its live styles`}
    >
      {snap.label}
    </span>
  );
}

// ------------------------------------------------------------------ journey

export interface WatchControl {
  phase: 'idle' | 'armed' | 'recording' | 'finishing';
  start(compare: Flow, snap?: ElementSnapshot): void;
  cancel(): void;
}

export function JourneyView({
  flows,
  compare,
  watch,
  technical,
  preview,
}: {
  flows: Flow[];
  compare?: Flow;
  watch?: WatchControl;
  technical: boolean;
  preview?: ElementSnapshot;
}) {
  const [index, setIndex] = useState(0);
  const flow = flows[Math.min(index, flows.length - 1)];
  const [tab, setTab] = useState<'journey' | 'layers'>('journey');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [fullSummary, setFullSummary] = useState(false);
  const [guide, setGuide] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => setOpen(new Set()), [flow]);
  const comparison = useMemo(() => (compare && flow?.mode === 'observed' ? compareFlows(compare, flow) : undefined), [compare, flow]);

  const toggle = (id: string, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (force ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Open a step and bring it into view (used by the Layers view). */
  const reveal = (id: string) => {
    setTab('journey');
    toggle(id, true);
    afterLayout(() => scrollStepIntoView(listRef.current, id));
  };

  const onToggle = (id: string) => {
    const opening = !open.has(id);
    toggle(id);
    if (opening) afterLayout(() => scrollStepIntoView(listRef.current, id));
  };

  if (!flow) return null;
  const counts = countEvidence(flow.steps);
  const steps = flow.steps;

  return (
    <div class="journey-view">
      <section class="hero">
        {flows.length > 1 ? (
          <div class="j-switch" role="tablist" aria-label="This element reacts to">
            {flows.map((f, i) => (
              <button role="tab" aria-selected={i === index} class={i === index ? 'on' : ''} onClick={() => setIndex(i)}>
                {f.steps[0]?.subtitle ?? `handler ${i + 1}`}
              </button>
            ))}
          </div>
        ) : null}
        <div class="hero-top">
          <div class="hero-element">
            {preview ? <ElementReplica snap={preview} /> : <Icon3D name={steps[0] ? STEP_ICON[steps[0].type] : 'unknown'} size={34} />}
          </div>
          <div class="hero-text">
            <h2 class="j-question">{flow.question}</h2>
            <p class="j-headline">{flow.headline}</p>
          </div>
        </div>
        {fullSummary ? (
          <p class="j-summary">
            <Rich text={flow.summary} />
          </p>
        ) : null}
        <div class="j-actions">
          <div class="j-basis">
            {flow.mode === 'observed' ? (
              <span>
                <Certainty evidence="runtime" /> Recorded just now
                {comparison?.confirmed ? ` · ${comparison.confirmed} likely link${comparison.confirmed > 1 ? 's' : ''} confirmed` : ''}
              </span>
            ) : (
              <span title="This journey comes from reading the source code. Nothing has been run yet.">
                From reading the code
                {counts.inferred ? ` · ${counts.inferred} likely link${counts.inferred > 1 ? 's' : ''}` : ''}
                {counts.unresolved ? ` · ${counts.unresolved} unknown` : ''}
              </span>
            )}
            <span class="j-links">
              <button class="link-btn" onClick={() => setFullSummary(!fullSummary)} aria-expanded={fullSummary}>
                {fullSummary ? 'Less' : 'Full explanation'}
              </button>
              <button class="link-btn" onClick={() => setGuide(!guide)} aria-expanded={guide}>
                How sure?
              </button>
            </span>
          </div>
          {watch && flow.mode === 'static' && steps.length > 0 ? (
            watch.phase === 'idle' ? (
              <button class="watch-btn" onClick={() => watch.start(flow)} title="Record what really runs the next time you use the page">
                {Icon.play()} Watch it happen
              </button>
            ) : (
              <button class="watch-btn armed" onClick={() => watch.cancel()}>
                <span class="rec-dot" /> {watch.phase === 'armed' ? 'Waiting for you…' : 'Recording…'}
              </button>
            )
          ) : null}
        </div>
        {guide ? <CertaintyGuide /> : null}
        {watch && watch.phase === 'armed' && flow.mode === 'static' ? (
          <div class="j-armed" role="status">
            Now use the page: {plain(steps[0]?.title ?? 'interact with it').replace(/^You /, '')}. TraceNaut records what runs until things settle.
          </div>
        ) : null}
      </section>

      {steps.length > 1 ? (
        <div class="view-tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === 'journey'} class={tab === 'journey' ? 'on' : ''} onClick={() => setTab('journey')}>
            Step by step
          </button>
          <button role="tab" aria-selected={tab === 'layers'} class={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>
            Layers
          </button>
        </div>
      ) : null}

      {tab === 'layers' ? (
        <LayersView flow={flow} preview={preview} onOpenStep={reveal} />
      ) : (
        <ol class="journey" ref={listRef}>
          {groupByZone(steps).map((group) =>
            group.zone === 'network' ? (
              group.steps.map((step) => (
                <StepItem key={step.id} step={step} open={open.has(step.id)} onToggle={() => onToggle(step.id)} technical={technical} tag={comparison?.tags.get(step.id)} />
              ))
            ) : (
              <li class={`zone z-${group.zone}`} key={group.steps[0].id}>
                <ZoneHeader zone={group.zone} steps={group.steps} />
                <ol class="zone-steps">
                  {foldIncidental(group.steps).map((item) =>
                    'fold' in item && !unfolded.has(item.fold[0].id) ? (
                      <li key={`fold-${item.fold[0].id}`} class="step-fold">
                        <button onClick={() => setUnfolded(new Set([...unfolded, item.fold[0].id]))} aria-expanded="false">
                          <span class="fold-count">{item.fold.length}</span> more parts of the page’s code also ran during the recording
                          <span class="fold-hint">not shown to follow from your action · show</span>
                        </button>
                      </li>
                    ) : (
                      ('fold' in item ? item.fold : [item.step]).map((step) => (
                        <StepItem key={step.id} step={step} open={open.has(step.id)} onToggle={() => onToggle(step.id)} technical={technical} tag={comparison?.tags.get(step.id)} />
                      ))
                    ),
                  )}
                </ol>
              </li>
            ),
          )}
        </ol>
      )}

      {comparison && comparison.missed.length ? (
        <section class="j-missed">
          <div class="section-title">In the code, but didn't run this time</div>
          <ul>
            {comparison.missed.map((s) => (
              <li key={s.id}>
                <Icon3D name="static" size={18} />
                <span>
                  {s.title}
                  {s.detail ? <span class="j-missed-sub"> · {s.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p class="j-note">These parts exist in the source code, but the recorded run took a different path (for example a different branch, or an error).</p>
        </section>
      ) : null}

      {flow.notes.length ? (
        <section class="j-notes">
          {flow.notes.map((n) => (
            <p key={n} class="j-note">
              {n}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function afterLayout(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Keep an expanded step readable: bring its detail into view without pushing its header out. */
function scrollStepIntoView(list: HTMLElement | null, id: string) {
  const el = list?.querySelector<HTMLElement>(`[data-step="${id}"]`);
  const scroller = el?.closest<HTMLElement>('.body');
  if (!el || !scroller) return;
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let delta = 0;
  if (r.bottom > s.bottom - 12) delta = Math.min(r.bottom - s.bottom + 12, r.top - s.top - 8);
  else if (r.top < s.top + 8) delta = r.top - s.top - 8;
  if (delta) scroller.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
}

/** Runs of two or more incidental steps become one fold; other steps stay as they are. */
function foldIncidental(steps: FlowStep[]): ({ step: FlowStep } | { fold: FlowStep[] })[] {
  const out: ({ step: FlowStep } | { fold: FlowStep[] })[] = [];
  let run: FlowStep[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ fold: run });
    else for (const s of run) out.push({ step: s });
    run = [];
  };
  for (const s of steps) {
    if (s.incidental) run.push(s);
    else {
      flush();
      out.push({ step: s });
    }
  }
  flush();
  return out;
}

function groupByZone(steps: FlowStep[]) {
  const groups: { zone: Zone; steps: FlowStep[] }[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.zone === s.zone && s.zone !== 'network') last.steps.push(s);
    else groups.push({ zone: s.zone, steps: [s] });
  }
  return groups;
}

// ------------------------------------------------------------------ zone header: the place, its technologies

function ZoneHeader({ zone, steps }: { zone: Zone; steps: FlowStep[] }) {
  const techs = uniqueTech(steps).filter((t) => t.kind !== 'runtime');
  return (
    <div class="zone-head">
      <Icon3D name={ZONE_ICON[zone]} size={26} />
      <span class="zone-label">{ZONE_LABEL[zone as Exclude<Zone, 'network'>]}</span>
      <span class="zone-tech">
        {techs.map((t) => (
          <TechChip key={t.id} tech={t} />
        ))}
      </span>
    </div>
  );
}

export function uniqueTech(steps: FlowStep[]) {
  const out = new Map<string, TechRef>();
  for (const s of steps) for (const t of s.tech) if (!out.has(t.id)) out.set(t.id, t);
  return [...out.values()];
}

export function techExtra(tech: TechRef) {
  return { role: tech.role, evidence: tech.evidence, name: tech.name, kind: tech.kind, what: tech.what, effect: tech.effect, asset: tech.asset, logo: tech.logo };
}

export function TechChip({ tech }: { tech: TechRef }) {
  const ex = useExplain();
  const extra = techExtra(tech);
  return (
    <button
      class={`tech-chip k-${tech.kind}`}
      onMouseEnter={(e) => ex.hover(tech.id, e.currentTarget as Element, extra)}
      onMouseLeave={() => ex.leave()}
      onFocus={(e) => ex.hover(tech.id, e.currentTarget as Element, extra)}
      onBlur={() => ex.leave()}
      onClick={(e) => ex.pin(tech.id, e.currentTarget as Element, extra)}
      aria-label={`${tech.name}, ${KIND_LABEL[tech.kind].label}`}
    >
      {tech.asset ? <Icon3D name={tech.asset} size={14} /> : null}
      {tech.name}
    </button>
  );
}

// ------------------------------------------------------------------ steps

function StepItem({ step, open, onToggle, technical, tag }: { step: FlowStep; open: boolean; onToggle: () => void; technical: boolean; tag?: StepTag }) {
  const crossing = step.zone === 'network';
  const status = step.observed?.status;
  return (
    <li class={`step z-${step.zone} ev-${step.evidence}${crossing ? ' crossing' : ''}${open ? ' open' : ''}`} data-step={step.id}>
      <button class="step-main" onClick={onToggle} aria-expanded={open}>
        <span class="step-icon">
          <Icon3D name={STEP_ICON[step.type]} size={30} />
          <span class={`pip ev-${step.evidence}`} title={CERTAINTY[step.evidence].word} />
        </span>
        <span class="step-text">
          <span class="step-title">{step.title}</span>
          {step.subtitle ? (
            <span class={`step-sub${crossing || step.type === 'database' ? ' mono' : ''}${status ? (status >= 400 ? ' bad' : ' good') : ''}`}>{step.subtitle}</span>
          ) : null}
        </span>
        <span class="step-side">
          {tag ? <span class={`step-tag ${tag}`}>{tag === 'new' ? 'Only seen running' : 'Confirmed'}</span> : null}
          {crossing
            ? step.tech
                .filter((t) => t.kind === 'protocol' || t.kind === 'data-format')
                .map((t) => (
                  <span class={`mini-chip k-${t.kind}`} key={t.id}>
                    {t.name}
                  </span>
                ))
            : null}
          <span class="chev-s" aria-hidden="true">
            {Icon.chev({ size: 12 })}
          </span>
        </span>
      </button>
      {open ? <StepDetail step={step} technical={technical} /> : null}
    </li>
  );
}

function StepDetail({ step, technical }: { step: FlowStep; technical: boolean }) {
  const nav = useNav();
  const [codeOpen, setCodeOpen] = useState(false);
  const [focusFn, setFocusFn] = useState<string | null>(null);
  const anchors = focusFn ? step.code.filter((c) => c.nodeId === focusFn).concat(step.code.filter((c) => c.nodeId !== focusFn)) : step.code;
  const showTech = step.tech.filter((t) => t.kind !== 'runtime' || step.type === 'server-entry');

  return (
    <div class="detail">
      <p class="detail-summary">
        <Rich text={step.summary} />
      </p>

      {step.facts.length ? (
        <dl class="j-facts">
          {step.facts.map((f, i) => (
            <div class="j-fact" key={i}>
              <dt>{f.label}</dt>
              <dd class={step.type === 'database' ? 'mono' : ''}>
                <Rich text={f.value} />
                {f.evidence && RANK[f.evidence] < RANK[step.evidence] ? <Certainty evidence={f.evidence} /> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {step.functions.length && step.type !== 'ui-update' ? (
        <div class="detail-block">
          <div class="detail-label">Code that runs here</div>
          <div class="fn-chain">
            {step.functions.map((f, i) => (
              <>
                {i > 0 ? <span class="fn-arrow">→</span> : null}
                <button
                  key={f.node.id}
                  class={`fn-chip ev-${f.evidence}`}
                  title={`${f.calledBy ? `Runs because ${f.calledBy} ${f.calledBy.startsWith('the “') ? 'happens' : 'calls it'}` : ''}${f.params.length ? ` · receives ${f.params.join(', ')}` : ''}${f.durationMs !== undefined ? ` · took ${f.durationMs} ms` : ''}`}
                  onClick={() => {
                    setFocusFn(f.node.id);
                    setCodeOpen(true);
                  }}
                >
                  {f.node.label}
                  <span class="fn-params">({f.params.join(', ')})</span>
                </button>
              </>
            ))}
          </div>
        </div>
      ) : null}

      {showTech.length ? (
        <div class="detail-tech">
          <span class="detail-label">Uses</span>
          {showTech.map((t) => (
            <TechChip key={t.id} tech={t} />
          ))}
        </div>
      ) : null}

      <div class="detail-foot">
        <span class="detail-cert">
          <Icon3D name={EVIDENCE_ICON[step.evidence]} size={20} />
          <span>
            <b>{CERTAINTY[step.evidence].word}</b>
            {technical ? <span class="cert-tech"> {step.evidence}</span> : null}
            {' · '}
            {step.evidenceNote ?? CERTAINTY[step.evidence].help}
          </span>
        </span>
        <span class="detail-actions">
          {step.code.length ? (
            <button class="soft-btn" onClick={() => setCodeOpen(!codeOpen)} aria-expanded={codeOpen}>
              {Icon.code()} {codeOpen ? 'Hide the code' : step.zone === 'network' && step.code.length > 1 ? 'Show the code on both sides' : 'Show the code'}
            </button>
          ) : null}
          {step.code[0] ? (
            <button class="soft-btn ghost" onClick={() => nav.open({ kind: 'node', id: focusFn ?? step.code[0].nodeId })}>
              Technical details ›
            </button>
          ) : null}
        </span>
      </div>

      {codeOpen ? (
        <div class="code-layer">
          {anchors.slice(0, step.zone === 'network' ? 2 : 1).map((a) => (
            <AnchorCode key={a.nodeId} nodeId={a.nodeId} label={a.label} />
          ))}
          {step.zone !== 'network' && anchors.length > 1 ? (
            <div class="anchor-tabs">
              Also:{' '}
              {anchors.slice(1).map((a) => (
                <button class="link-btn" onClick={() => setFocusFn(a.nodeId)}>
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
          <p class="code-hint">Hover the dotted parts of the code to see what that notation means.</p>
        </div>
      ) : null}
    </div>
  );
}

function AnchorCode({ nodeId, label }: { nodeId: string; label: string }) {
  const state = useAsync(() => api.node(nodeId), [nodeId]);
  return (
    <div class="anchor">
      <div class="anchor-label">{label}</div>
      {state.loading ? <div class="row-note">Loading…</div> : state.error ? <div class="row-note">{state.error}</div> : state.data?.code ? <CodeBlock code={state.data.code} wrap /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ comparison

type StepTag = 'new' | 'confirmed';

function compareFlows(staticFlow: Flow, observed: Flow) {
  const staticKeys = new Map<string, FlowStep>();
  for (const s of staticFlow.steps) for (const k of s.keys) staticKeys.set(k, s);
  const observedKeys = new Set(observed.steps.flatMap((s) => s.keys));
  const tags = new Map<string, StepTag>();
  let confirmed = 0;
  for (const s of observed.steps) {
    const matches = s.keys.map((k) => staticKeys.get(k)).filter((x): x is FlowStep => !!x);
    if (!matches.length && s.keys.length) tags.set(s.id, 'new');
    else if (matches.some((m) => m.evidence === 'inferred')) {
      tags.set(s.id, 'confirmed');
      confirmed++;
    }
  }
  // Whole steps that never ran, and parts of steps that ran only partly.
  const missed: { id: string; title: string; detail?: string }[] = [];
  for (const s of staticFlow.steps) {
    if (!s.keys.length) continue;
    const absent = s.keys.filter((k) => !observedKeys.has(k));
    if (absent.length === s.keys.length) missed.push({ id: s.id, title: plain(s.title), detail: s.subtitle });
    else if (absent.length) missed.push({ id: s.id, title: `Part of “${plain(s.title)}”`, detail: absent.map((k) => keyLabel(s, k)).join(', ') });
  }
  return { tags, missed, confirmed };
}

function keyLabel(step: FlowStep, key: string) {
  const fn = step.functions.find((f) => f.node.id === key);
  if (fn) return fn.node.label;
  if (key.startsWith('sql:')) {
    const fact = step.facts.find((f) => `sql:${f.value}` === key);
    return fact ? fact.label.toLowerCase() : 'an SQL statement';
  }
  return key;
}

function countEvidence(steps: FlowStep[]) {
  const c: Record<Evidence, number> = { runtime: 0, static: 0, inferred: 0, unresolved: 0 };
  for (const s of steps) c[s.evidence]++;
  return c;
}
