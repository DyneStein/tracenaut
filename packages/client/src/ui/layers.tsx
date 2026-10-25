import { useState } from 'preact/hooks';
import type { Evidence, Flow, FlowStep, Zone } from '@tracenaut/protocol';
import type { ElementSnapshot } from '../adapters.js';
import { Rich } from '../learn/explain.js';
import { CERTAINTY, ElementReplica, RANK, TechChip, ZONE_LABEL, uniqueTech } from './journey.js';
import { EVIDENCE_ICON, Icon3D, STEP_ICON, ZONE_ICON, assetUrl } from './icon3d.js';

/**
 * "What exists behind this element": the places the interaction passes through, drawn as
 * stacked 2.5D layers joined by the connections that cross between them. Built only from
 * the journey's steps, so a layer or connection appears only if the journey contains it,
 * and connection lines carry the same certainty styling as the steps.
 */

type Place = Exclude<Zone, 'network'>;
type Selection = { kind: 'element' } | { kind: 'layer'; zone: Place } | { kind: 'link'; step: FlowStep } | null;

const HUE: Record<Place, string> = { browser: '#7c7cff', server: '#2ec4a0', database: '#f2a03d' };

/** One request and what follows from it, in journey order. */
interface Lane {
  request: FlowStep;
  /** The request as far as it reaches the server: no more certain than the route match. */
  crossing: FlowStep;
  entry?: FlowStep;
  database: FlowStep[];
  response?: FlowStep;
  then?: FlowStep;
}

function lanesOf(steps: FlowStep[]): Lane[] {
  const lanes: Lane[] = [];
  let cur: Lane | undefined;
  for (const s of steps) {
    if (s.type === 'request') {
      cur = { request: s, crossing: s, database: [] };
      lanes.push(cur);
    } else if (!cur) continue;
    else if (!cur.entry && (s.type === 'server-entry' || (s.type === 'unknown' && s.zone === 'server'))) cur.entry = s;
    else if (s.type === 'database') cur.database.push(s);
    else if (s.type === 'response') cur.response = s;
    // Only a page update counts as "then": other browser code may just be preparing the next request.
    else if (cur.response && !cur.then && s.type === 'ui-update') cur.then = s;
  }
  for (const l of lanes) {
    if (l.entry && RANK[l.entry.evidence] < RANK[l.request.evidence]) l.crossing = { ...l.request, evidence: l.entry.evidence, evidenceNote: l.entry.evidenceNote };
  }
  return lanes;
}

const SHOWN_LANES = 2;

export function LayersView({ flow, preview, onOpenStep }: { flow: Flow; preview?: ElementSnapshot; onOpenStep: (id: string) => void }) {
  const [sel, setSel] = useState<Selection>(null);
  const [allLanes, setAllLanes] = useState(false);
  const steps = flow.steps;
  const places = (['browser', 'server', 'database'] as const).filter((z) => steps.some((s) => s.zone === z));
  const interaction = steps.find((s) => s.type === 'interaction');
  const lanes = lanesOf(steps);
  const shown = allLanes ? lanes : lanes.slice(0, SHOWN_LANES);
  const hidden = lanes.length - shown.length;
  const dbSteps = lanes.flatMap((l) => l.database);
  const middleware = [...new Set(lanes.flatMap((l) => l.entry?.middleware ?? []))];

  const isSel = (s: Selection) => JSON.stringify(s && { ...s, step: s.kind === 'link' ? s.step.id : undefined }) === JSON.stringify(sel && { ...sel, step: sel.kind === 'link' ? sel.step.id : undefined });
  const pick = (s: Selection) => setSel(isSel(s) ? null : s);

  return (
    <div class="layers-view">
      <p class="layers-intro">What sits behind {preview ? 'your element' : 'this interaction'}, layer by layer. Select a layer or a connection.</p>
      <div class="layers" role="group" aria-label="Layers behind the element">
        <button class={`layer-row element${isSel({ kind: 'element' }) ? ' on' : ''}`} onClick={() => pick({ kind: 'element' })} aria-pressed={isSel({ kind: 'element' })}>
          <span class="layer-art">
            <span class="element-card">{preview ? <ElementReplica snap={preview} /> : <Icon3D name="interaction" size={40} />}</span>
          </span>
          <span class="layer-label">
            <b>Your element</b>
            <span>{preview ? `<${preview.tag}> “${preview.label}”` : interaction?.title ?? ''}</span>
          </span>
        </button>

        {interaction && places.includes('browser') ? (
          <LinkRow down={{ step: interaction, label: interaction.subtitle ?? 'handled by code' }} hue={HUE.browser} pick={pick} isSel={isSel} />
        ) : null}

        {places.map((zone, i) => (
          <>
            <LayerRow
              key={zone}
              zone={zone}
              steps={steps.filter((s) => s.zone === zone)}
              chips={zone === 'server' ? middleware : undefined}
              selected={isSel({ kind: 'layer', zone })}
              onClick={() => pick({ kind: 'layer', zone })}
            />
            {zone === 'browser' && places[i + 1] === 'server' && lanes.length ? (
              <div class={`lanes${lanes.length > 1 ? ' multi' : ''}`}>
                {shown.map((l, n) => (
                  <LinkRow
                    key={l.request.id}
                    lane={lanes.length > 1 ? n + 1 : undefined}
                    down={{ step: l.crossing, label: l.request.subtitle ?? 'request' }}
                    up={l.response ? { step: l.response, label: l.response.branches ? 'answers' : (l.response.subtitle ?? 'answer') } : undefined}
                    branches={l.response?.branches}
                    then={l.then}
                    hue="#38bdf8"
                    pick={pick}
                    isSel={isSel}
                  />
                ))}
                {lanes.length > SHOWN_LANES ? (
                  <button class="lanes-more" onClick={() => setAllLanes(!allLanes)} aria-expanded={allLanes}>
                    {allLanes ? 'Show fewer requests' : `Show ${hidden} more request${hidden > 1 ? 's' : ''}`}
                  </button>
                ) : null}
              </div>
            ) : null}
            {zone === 'server' && places[i + 1] === 'database' && dbSteps.length ? (
              <div class={`lanes${dbSteps.length > 1 ? ' multi' : ''}`}>
                {(allLanes ? dbSteps : dbSteps.slice(0, SHOWN_LANES)).map((d) => (
                  <LinkRow key={d.id} down={{ step: d, label: `${d.facts.some((f) => /^Prisma:/.test(f.value)) ? 'Prisma' : 'SQL'} · ${d.subtitle ?? ''}` }} hue={HUE.database} pick={pick} isSel={isSel} />
                ))}
                {!allLanes && dbSteps.length > SHOWN_LANES ? (
                  <button class="lanes-more" onClick={() => setAllLanes(true)}>
                    Show {dbSteps.length - SHOWN_LANES} more
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ))}
      </div>

      <div class="layer-detail" aria-live="polite">
        {sel ? <Detail sel={sel} flow={flow} preview={preview} onOpenStep={onOpenStep} /> : <p class="layers-hint">Nothing selected yet.</p>}
      </div>
    </div>
  );
}

function LayerRow({ zone, steps, chips, selected, onClick }: { zone: Place; steps: FlowStep[]; chips?: string[]; selected: boolean; onClick: () => void }) {
  const tech = uniqueTech(steps).filter((t) => t.kind === 'language' || t.kind === 'framework' || t.kind === 'database' || t.kind === 'runtime');
  // A layer known only as "something must be here" is drawn as an outline: the journey
  // reaches it, but nothing in it could be determined.
  const ghost = steps.every((s) => s.evidence === 'unresolved');
  return (
    <button class={`layer-row${selected ? ' on' : ''}${ghost ? ' ghost' : ''}`} onClick={onClick} aria-pressed={selected}>
      <span class="layer-art">
        <Slab hue={HUE[zone]} icon={ghost ? 'unknown' : ZONE_ICON[zone]} ghost={ghost} />
      </span>
      <span class="layer-label">
        <b>{ZONE_LABEL[zone]}</b>
        <span>{ghost ? 'Can’t tell what happens here' : tech.map((t) => t.name).join(' · ') || `${steps.length} step${steps.length > 1 ? 's' : ''}`}</span>
        {chips?.length ? (
          <span class="mw-chips" aria-label="Runs before the route">
            {chips.map((c) => (
              <span class="mw-chip" key={c}>
                {c}
              </span>
            ))}
            <span class="mw-chip end">route</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

function LinkRow({
  down,
  up,
  branches,
  then,
  lane,
  hue,
  pick,
  isSel,
}: {
  down: { step: FlowStep; label: string };
  up?: { step: FlowStep; label: string };
  branches?: FlowStep['branches'];
  then?: FlowStep;
  lane?: number;
  hue: string;
  pick: (s: Selection) => void;
  isSel: (s: Selection) => boolean;
}) {
  return (
    <div class="link-row">
      <svg class="link-art" viewBox="0 0 168 44" width="168" height="44" aria-hidden="true">
        <Arrow x={up ? 76 : 84} down evidence={down.step.evidence} hue={hue} />
        {up ? <Arrow x={92} evidence={up.step.evidence} hue="#34d399" /> : null}
      </svg>
      <span class="link-labels">
        {lane ? <span class="lane-no">Request {lane}</span> : null}
        <button class={`link-pill ev-${down.step.evidence}${isSel({ kind: 'link', step: down.step }) ? ' on' : ''}`} onClick={() => pick({ kind: 'link', step: down.step })}>
          <span aria-hidden="true">↓</span> {down.label}
        </button>
        {up ? (
          <span class="up-group">
            <button class={`link-pill ev-${up.step.evidence}${isSel({ kind: 'link', step: up.step }) ? ' on' : ''}`} onClick={() => pick({ kind: 'link', step: up.step })}>
              <span aria-hidden="true">↑</span> {up.label}
            </button>
            {branches?.map((b) => (
              <span key={String(b.status)} class={`branch ${b.status === '?' ? '' : Number(b.status) >= 400 ? 'bad' : 'good'}`} title="One possible answer; which one happens depends on the request">
                {b.label}
              </span>
            ))}
          </span>
        ) : null}
        {then ? (
          <button class={`link-pill then ev-${then.evidence}${isSel({ kind: 'link', step: then }) ? ' on' : ''}`} onClick={() => pick({ kind: 'link', step: then })}>
            <span aria-hidden="true">↩</span> then: {then.title.toLowerCase()}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** A vertical connection whose line style states its certainty, like the journey's rails. */
function Arrow({ x, down = false, evidence, hue }: { x: number; down?: boolean; evidence: Evidence; hue: string }) {
  const dash = evidence === 'inferred' ? '5 4' : evidence === 'unresolved' ? '1.5 4' : undefined;
  const color = evidence === 'runtime' ? '#34d399' : hue;
  const tip = down ? `M${x - 4.5} 34 L${x} 41 L${x + 4.5} 34` : `M${x - 4.5} 10 L${x} 3 L${x + 4.5} 10`;
  return (
    <g>
      <line x1={x} y1={down ? 2 : 42} x2={x} y2={down ? 39 : 5} stroke={color} stroke-width="2.4" stroke-dasharray={dash} stroke-linecap="round" />
      <path d={tip} fill="none" stroke={color} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </g>
  );
}

/** An isometric slab: one layer of the system, with its place icon standing on top. */
function Slab({ hue, icon, ghost = false }: { hue: string; icon: string; ghost?: boolean }) {
  const id = `slab-${hue.slice(1)}${ghost ? '-g' : ''}`;
  if (ghost) {
    return (
      <svg class="slab ghost" viewBox="0 0 168 92" width="168" height="92" aria-hidden="true">
        <path d="M10 36 L84 0 L158 36 L84 72 Z M10 36 L10 48 L84 84 L158 48 L158 36 M84 72 L84 84" fill="none" stroke={hue} stroke-opacity=".7" stroke-width="1.4" stroke-dasharray="4 4" />
        <image href={assetUrl(icon)} x="66" y="14" width="36" height="36" opacity=".55" />
      </svg>
    );
  }
  const src = assetUrl(icon);
  return (
    <svg class="slab" viewBox="0 0 168 92" width="168" height="92" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color={hue} stop-opacity=".5" />
          <stop offset="1" stop-color={hue} stop-opacity=".22" />
        </linearGradient>
        <linearGradient id={`${id}-l`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={hue} stop-opacity=".75" />
          <stop offset="1" stop-color={hue} stop-opacity=".45" />
        </linearGradient>
        <linearGradient id={`${id}-r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={hue} stop-opacity=".95" />
          <stop offset="1" stop-color={hue} stop-opacity=".6" />
        </linearGradient>
        <radialGradient id={`${id}-s`}>
          <stop offset="0" stop-color="#05060d" stop-opacity=".3" />
          <stop offset="1" stop-color="#05060d" stop-opacity="0" />
        </radialGradient>
      </defs>
      <ellipse class="slab-shadow" cx="84" cy="80" rx="78" ry="10" fill={`url(#${id}-s)`} />
      <g class="slab-body">
        <path d="M10 36 L84 72 L84 84 L10 48 Z" fill={`url(#${id}-l)`} />
        <path d="M84 72 L158 36 L158 48 L84 84 Z" fill={`url(#${id}-r)`} style={{ filter: 'brightness(.7)' }} />
        <path d="M10 36 L84 0 L158 36 L84 72 Z" fill={`url(#${id}-t)`} stroke={hue} stroke-opacity=".7" stroke-width="1" />
        <path d="M10 36 L84 0 L158 36" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1" />
        <image href={src} x="60" y="8" width="48" height="48" />
      </g>
    </svg>
  );
}

function Detail({ sel, flow, preview, onOpenStep }: { sel: NonNullable<Selection>; flow: Flow; preview?: ElementSnapshot; onOpenStep: (id: string) => void }) {
  if (sel.kind === 'element') {
    const interaction = flow.steps.find((s) => s.type === 'interaction');
    return (
      <div class="detail-card">
        <div class="detail-card-head">
          <Icon3D name="interaction" size={30} />
          <div>
            <b>Your element</b>
            <span>{preview ? 'Drawn from its live styles; simplified.' : 'The element that starts this interaction.'}</span>
          </div>
        </div>
        {interaction ? (
          <>
            <p>
              <Rich text={interaction.summary} />
            </p>
            <button class="soft-btn" onClick={() => onOpenStep(interaction.id)}>
              Open this step ›
            </button>
          </>
        ) : null}
      </div>
    );
  }
  if (sel.kind === 'layer') {
    const steps = flow.steps.filter((s) => s.zone === sel.zone);
    const weakest = steps.reduce<Evidence>((a, s) => (RANK[s.evidence] < RANK[a] ? s.evidence : a), 'runtime');
    const tech = uniqueTech(steps);
    return (
      <div class="detail-card">
        <div class="detail-card-head">
          <Icon3D name={ZONE_ICON[sel.zone]} size={30} />
          <div>
            <b>{ZONE_LABEL[sel.zone]}</b>
            <span>
              {steps.length} step{steps.length > 1 ? 's' : ''} happen here
            </span>
          </div>
        </div>
        <ul class="layer-steps">
          {steps.map((s) => (
            <li key={s.id}>
              <button onClick={() => onOpenStep(s.id)}>
                <Icon3D name={STEP_ICON[s.type]} size={22} />
                <span>{s.title}</span>
                <span class={`pip ev-${s.evidence}`} title={CERTAINTY[s.evidence].word} />
              </button>
            </li>
          ))}
        </ul>
        {tech.length ? (
          <div class="detail-tech">
            <span class="detail-label">Technologies</span>
            {tech.map((t) => (
              <TechChip key={t.id} tech={t} />
            ))}
          </div>
        ) : null}
        <div class="detail-cert">
          <Icon3D name={EVIDENCE_ICON[weakest]} size={18} />
          <span>
            <b>{CERTAINTY[weakest].word}</b> · the least certain step in this layer
          </span>
        </div>
      </div>
    );
  }
  const s = sel.step;
  return (
    <div class="detail-card">
      <div class="detail-card-head">
        <Icon3D name={STEP_ICON[s.type]} size={30} />
        <div>
          <b>{s.title}</b>
          <span class="mono">{s.subtitle}</span>
        </div>
      </div>
      <p>
        <Rich text={s.summary} />
      </p>
      <div class="detail-cert">
        <Icon3D name={EVIDENCE_ICON[s.evidence]} size={18} />
        <span>
          <b>{CERTAINTY[s.evidence].word}</b> · {s.evidenceNote ?? CERTAINTY[s.evidence].help}
        </span>
      </div>
      <button class="soft-btn" onClick={() => onOpenStep(s.id)}>
        Open this step ›
      </button>
    </div>
  );
}
