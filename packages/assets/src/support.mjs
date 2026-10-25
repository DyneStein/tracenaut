/**
 * Support levels for a technology, kept separate on purpose: an icon is not analysis.
 * `static`, `runtime` and `trace` are declared in the registry only for what the engine
 * actually implements and tests; the rest is computed.
 */
export const LEVELS = [
  { id: 'visual', short: 'Icon', help: 'TraceNaut can show it (official logo or TraceNaut icon).' },
  { id: 'detect', short: 'Detect', help: 'TraceNaut can tell, from repository evidence, that the project uses it.' },
  { id: 'static', short: 'Static', help: 'TraceNaut analyses its code structure (calls, routes, queries).' },
  { id: 'runtime', short: 'Runtime', help: 'TraceNaut observes it while the app runs.' },
  { id: 'trace', short: 'Trace', help: 'TraceNaut links it across the system (e.g. request → route → SQL).' },
  { id: 'explain', short: 'Explain', help: 'A plain-language explanation is available.' },
];

export function supportOf(t) {
  const s = t.signals ?? {};
  return {
    visual: !!(t.logo || t.icon),
    detect: !!(s.npm?.length || s.ext?.length || s.files?.length || s.py?.length || s.manifest?.length || s.imports?.length || s.text),
    static: !!t.support?.static,
    runtime: !!t.support?.runtime,
    trace: !!t.support?.trace,
    explain: !!t.what,
  };
}
