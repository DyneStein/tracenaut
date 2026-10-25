# TraceNaut architecture

> Don't start by reading the code. Start by experiencing the software, then follow the code behind it.

This document records the technical direction of TraceNaut: what is hard, what we built, why, and how it grows.

## 1. The problem, restated as engineering problems

The product promise is: *point at something in a running app → see the code behind it → follow what it does, across services, without being lied to.* That decomposes into four separate problems with different difficulty:

| # | Problem | Difficulty | Our answer |
|---|---------|------------|------------|
| 1 | **Element → source.** Which JSX produced this DOM node? | Hard to do *exactly* after the fact (source maps and React internals are lossy and version-dependent). | Trivial and exact if we record it at build time. |
| 2 | **Source → what it can do.** Handlers, calls, requests, routes, SQL. | Needs real symbol resolution (imports, re-exports, destructuring, props). Regex/grep gives confident wrong answers. | The TypeScript compiler's type checker (handles TS *and* JS). |
| 3 | **Crossing the network boundary.** Which backend route does `fetch(...)` reach? | Statically, only a heuristic. | Static: method + path pattern matching, labelled **inferred**. Runtime: a correlation header, **observed**. |
| 4 | **What actually happened.** | Requires instrumentation. | Opt-in function probes, active only during an explicitly armed trace. |

The insight that shaped everything: **separate "where is it / what can it do" (static, always available, safe) from "what did it do" (runtime, opt-in, explicit), and never let the UI blur the two.** Every relationship on the wire carries an `evidence` field: `static`, `runtime`, `inferred` or `unresolved`, plus a plain-language `note` explaining why.

## 2. Architecture

```
 Browser (dev page)                        Local daemon (127.0.0.1)                 Your backend (opt-in)
┌──────────────────────────┐   HTTP+token ┌───────────────────────────────┐  WS+token ┌──────────────────────────┐
│ TraceNaut client (Preact,│─────────────▶│ Analyzer (TypeScript LS per   │◀─────────▶│ node --import            │
│ Shadow DOM)              │              │ service): JSX, calls, props,  │           │   @tracenaut/node-agent  │
│ • React fiber adapter    │              │ fetch/axios request specs,    │           │ • probes via module hooks│
│ • probe runtime          │              │ routes (Express, Fastify,     │           │ • per-request ALS context│
│ • fetch/XHR observer     │              │ Hono, koa-router, Next.js),   │           │ • SQL text: node:sqlite, │
└──────────▲───────────────┘              │ SQL text, Prisma calls        │           │   better-sqlite3, pg     │
           │ injected by                  │ RuntimeHub · JourneyBuilder · │           └──────────────────────────┘
           │                              │ stack detection · /assets     │
           │                              └───────────────────────────────┘
┌──────────┴───────────────┐                          ▲ reads (never executes) the repo
│ @tracenaut/vite-plugin   │  build-time: data-tn-loc / data-tn-use on JSX, inactive function probes
└──────────────────────────┘
  Optional: Chrome extension adds "Inspect with TraceNaut" to the native right-click menu.
```

**Packages**

| Package | Role |
|---|---|
| `instrument` | One Babel plugin + probe runtime, shared by the browser and Node. JSX location attributes; function probes that bracket `await` so async call stacks stay correct. |
| `vite-plugin` | Dev-only (`apply: 'serve'`). Runs `instrument` on the original source (so locations are exact) and injects the client when a daemon for *this* repo is running. |
| `client` | In-page overlay: Alt+right-click menu, element picker, docked panel, code views with clickable call sites, relation trees, trace recorder. |
| `daemon` | CLI + local server. Analysis engine, node APIs, trace hub. Binds to 127.0.0.1, random token, local-origin CORS only, refuses paths outside the repo. |
| `node-agent` | Opt-in backend instrumentation through Node's `module.registerHooks`. |
| `extension` | Thin MV3 extension: native context-menu items that relay to the page client. |
| `protocol` | Wire types; the evidence model and query redaction live here. |
| `assets` | The technology and concept registry (names, kinds, detection signals, support levels, descriptions), vendored Simple Icons logos with licences, and the generated icon set, manifest and gallery. |

### Why this architecture (and not the alternatives)

- **Build-time JSX locations over React DevTools internals / source maps.** `_debugSource` was removed in React 19; owner stacks and source maps give approximate, version-dependent answers. A build step gives an exact `file:line:col` for every element, and for component usages too, so we get the *ownership chain* ("this `<button>` is the `<Button>` used in `LoginForm.tsx:38`") by reading our own props from the fiber tree. The same idea works for any JSX framework (Preact, Solid) and maps onto Vue/Svelte compilers later.
- **A local daemon, not a browser extension alone.** An extension cannot read the repository, run a type checker, or see the backend. The daemon is the only component that touches source; the browser only ever sends locations and receives analysed results. The extension is kept as an *optional* convenience for the native right-click menu, not the core.
- **TypeScript's language service over tree-sitter/LSP for the first language.** It gives real symbol resolution for both TS and JS, including `allowJs` backends, and "go to implementation"/"find references" for free. The internal model is deliberately LSP-shaped (definitions, references, outgoing calls), so other languages plug in through their language servers (pyright, gopls, rust-analyzer…) rather than bespoke parsers.
- **Our own probes over OpenTelemetry for the MVP.** OTel gives service- and span-level visibility (HTTP, DB) but not *which of your functions ran, in what order*. That function-level causal tree is the learning experience. OTel ingestion is the right next step for distributed systems beyond what we instrument (see roadmap); it complements rather than replaces probes.
- **Probes over V8 coverage on the backend.** Precise coverage tells you *that* a function ran in a time window, process-wide. Probes with `AsyncLocalStorage` tell you *which request* ran it, in what order, called by whom, which is what correctness requires when several requests overlap.

## 3. Evidence model in practice

| You see | Means | Example |
|---|---|---|
| `static` | The relationship is written in the source. It may not execute. | `handleSubmit` calls `login` |
| `inferred` | A heuristic connection, with the heuristic stated. | `signIn` from context → the only compatible object literal providing it; `POST /api/auth/login` → route with the same method and path |
| `unresolved` | We could not know, and say why. | `fetch(`${base}/items`)` where `base` is mutable → `{base}` stays a placeholder |
| `runtime` | Observed in a trace. | the request returned 200; this SQL ran under `findUserByEmail` |

Rules the code enforces:
- Dynamic URL parts are rendered as `{name}` placeholders and never guessed. A request whose prefix is unknown is not matched to any route, with one explicit exception: when a URL-building helper puts a base address known only at runtime in front of a known path, the request is shown as `{base URL}/path`, matched by the end of route paths, and every such link is **inferred** with the assumption written in its note. A fixed request segment is never matched to a route parameter under that assumption.
- Receivers count as apps/routers only if they are created by `express()` / `Router()` / `fastify()` / `new Hono()` / `new Router()` imported from those packages; `map.get('/x')` or a local class called `Router` is not a route.
- Prisma calls are matched against the models declared in `.prisma` schemas; without the generated client the link is **inferred**.
- In a recording, a top-level call counts as run by the user's action only if it started while that action's events were being dispatched (`eventPhase` not `NONE`); everything else is shown as "also ran", never as a consequence.
- Runtime traces record function identities, timings, request method/URL/status, and SQL *text*. They never record request bodies, headers, SQL parameter values or return values.
- Only requests carrying the armed trace's header are recorded on the backend, so other traffic never pollutes a trace.

## 4. MVP scope (what exists now)

Verified end to end against `examples/taskboard` (React 19 + Vite 8, Express 5, `node:sqlite`) by the automated suite in `tests/`, statically against small fixtures for Fastify, Hono, koa-router, Next.js, axios and Prisma (`tests/fixtures/frameworks`), and on two public repositories (see `docs/COVERAGE.md`):

1. **Inspect** (Alt+right-click, picker, or extension menu): element → exact JSX, component ancestry, the usage site of reusable components, live-attached handlers (including ancestors reached by bubbling and form submission), handlers followed through props and `{...spread}` using the observed component chain.
2. **Progressive exploration**: expandable relation trees (calls, renders, requests, routes, middleware, SQL), clickable call sites in code, back/forward history, "find what calls this", library/state calls collapsed so users skip what they know.
3. **Cross-boundary static links**: requests are described relative to a function's parameters (`RequestSpec`: URL parts, method, body, client) and composed through wrapper layers (`component → get('/x') → httpGet(getUrl(url)) → request('GET', buildPath(path)) → fetch(url, { method })`), with URL builders inlined when they compute the same path on every return. Routes from five frameworks with prefixes and middleware order; SQL text and Prisma calls; possible answers per route.
4. **Trace next action**: the next interaction is recorded as an observed causal tree from the event handler through the network into the backend's functions and SQL, with re-renders summarised.
5. **Honest edges**: no source location, elements drawn by library components, unconnected agents, cross-origin requests, aborted requests, recording limits, an unreachable or restarted daemon (with retry) — all reported in the UI.
6. **Project stack**: `/api/stack` reads manifests and files (never executes anything) and lists the technologies a project uses with the evidence for each; the home view shows it as "Built with".

## 5. Risks and how they are handled

| Risk | Mitigation |
|---|---|
| Instrumentation changes app behaviour | Probes are a boolean check when idle; unit tests assert identical semantics (`this`, `arguments`, hoisting, getters). Production builds are untouched. Backend keeps line numbers and emits source maps. |
| Wrong relationships erode trust | Evidence on every edge; heuristics labelled; placeholders instead of guesses; fixture tests for look-alikes. |
| Large repositories | One TS program per service, built once and updated incrementally by mtime; the program is reused for 1 s bursts (stat calls dominated analysis time); per-function results are cached. Measured: ~5 s for a full analysis of 1,000–2,000-file repos (see `docs/COVERAGE.md`). Very large monorepos are not measured. |
| Security of a local server that reads source | Loopback only, per-session random token in a `0600` file, local-origin CORS, path traversal refused, no execution of repository code by TraceNaut itself. |
| Framework churn (React internals) | The React adapter reads only `return` / `memoizedProps` / `type` on fibers, and only to find props *we* added. A DOM-attribute fallback exists. |

## 6. The guided layer (journeys)

The learning experience sits on top of the engine without changing its guarantees:

```
analyzer relations / recorded trace ──▶ JourneyBuilder ──▶ Flow { question, summary, steps[] }
                                          │   segments by where code runs (browser · network · server · database)
                                          │   and by role (interaction, component code, app code, request,
                                          │   route, server code, SQL, response, page update)
                                          ├─ TechDetector: language / library / framework / runtime / protocol /
                                          │   data format / database, each with the evidence it came from
                                          └─ text from verified structure + [[term|concept]] markup
client: JourneyView (tech map + steps) · concept library + syntax spans (hover/click explanations) · Technical mode = inspector
```

- **Same picture, two certainties.** Static and observed journeys share a step format with matching keys (functions, routes, SQL text), so a recording upgrades the journey in place: confirmed links, steps only seen when running, and parts that did not run.
- **Explanations are curated, application facts are derived.** General definitions ("what is HTTP") ship with TraceNaut; "in this app" and "how TraceNaut knows" come from evidence. No AI is involved.
- **Syntax spans** come from the TypeScript syntax tree (async/await, JSX, destructuring, `?` SQL placeholders…), attached to every code view.

## 7. A technology-agnostic observation layer

Supporting stacks one adapter at a time does not scale, so the engine observes the boundaries every web stack must cross and treats technology knowledge as optional enrichment:

- **Browser:** JSX locations and function probes are inserted by one Babel transform, hosted by thin bundler plugins (Vite, Next.js loader for Turbopack and webpack). Probes find the runtime at call time, so load order does not matter. Causality comes from the DOM: a call counts as caused by an action only if it starts while that action's events are dispatched (`eventPhase`), or if the element's static journey leads to it (then *likely*).
- **Server:** the agent hooks Node's `http.Server` (any framework), outgoing requests via `diagnostics_channel` (`http.client.*`, `undici:*`, propagating the trace header to local services only), and **database wire protocols** by reading `net.Socket` writes (PostgreSQL Query/Parse/Bind/Execute, MySQL COM_QUERY, MongoDB OP_MSG, Redis RESP), replies by wrapping the socket's `emit` without adding listeners. Attribution: AsyncLocalStorage; a write whose async trigger chain leads back to the connection's own callbacks is "from the driver's queue" and never linked with certainty.
- **Knowledge as enrichment:** routes come from framework syntax where known and from runtime handler observation always; libraries are named from the registry or from their own `package.json`; a few library contracts are encoded explicitly (TanStack Query's `mutationFn`, router navigation by type, React form actions), always as *likely* links.

## 8. Recommended next steps

1. **AI explanations, grounded and opt-in.** "Explain" on any node, sending only that node's code plus its evidence-tagged relations; never sent without per-repository consent; local-model option. Deferred deliberately because it has privacy/cost implications that need a product decision.
2. **More stacks through the same seams.** A Next.js (webpack/Turbopack) instrumentation plugin so Next apps can be inspected in the browser, not only analysed; Vue/Svelte location attributes; Mongoose/Drizzle query analysis; Python backends (pyright + an import-hook agent); OTel/OTLP ingestion for services TraceNaut does not instrument.
3. **Runtime-confirmed static views.** After a trace, mark static edges that were observed and dim ones that did not execute ("could run, didn't").
4. **Multi-repo daemon and editor integration** (open-in-editor already works for VS Code, Cursor, JetBrains, Zed).
5. **Spatial/3D views** only once the above is solid, built on the same graph.
