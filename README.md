# TraceNaut

**Start with what the software does. Explore how it works. Understand the technologies behind it. Dive into the code when you choose.**

Alt+right-click anything in a running app and TraceNaut answers *what happens when you use it*: first in one sentence, then as a short journey through the system:

> You click “Sign in” → the LoginForm component's code runs → app code prepares the request → **HTTP POST /api/auth/login** (email, password as JSON) → the server receives it (Express on Node.js) → the server's code handles it → **SQL** reads users, adds to sessions (SQLite) → the server answers (200 OK · 401 Unauthorized) → the page updates

Steps are grouped by where the code runs (browser, server, database) and drawn with TraceNaut's own 2.5D icons. Each place lists its technologies (language, framework, runtime, protocol, database), with what they do here and how TraceNaut knows. The **Layers** view shows the same journey as stacked layers behind your element, joined by the connections that cross between them. Unfamiliar terms and code notation can be hovered for an explanation. The real code is one click away, including both sides of every browser-to-server crossing. Press **Watch it happen**, use the page, and the same journey comes back as what *actually* ran, with confirmed links and the parts that did not run this time.

Certainty is always shown, in plain words:

| Guided mode | Technical mode | Meaning |
|---|---|---|
| **Happened** | runtime | observed while recording |
| **In the code** | static | written in the source; it can happen |
| **Likely** | inferred | a connection worked out from the code, with the reason shown |
| **Can't tell** | unresolved | unknown, with the reason shown |

**Technical mode** (switch in the panel header) is the full inspector: functions, files, relation trees and call-level traces.

**What it understands today:** React apps on Vite or Next.js (Turbopack/webpack), inspected in the running browser; `fetch`, `axios`, TanStack Query, form actions and Server Actions; server routes in Express, Fastify, Hono, Koa and Next.js, confirmed at runtime; database statements read from the wire for PostgreSQL (any driver or ORM in the process: pg, postgres.js, Drizzle, Prisma's pg adapter…), SQLite, and (protocol-tested) MySQL, MongoDB and Redis. Libraries TraceNaut has no entry for are still named and explained from their own `package.json`. The home view lists what your project is built with, and which of those technologies TraceNaut can follow. See [`docs/COVERAGE.md`](docs/COVERAGE.md) for the full matrix and the validation on two public repositories, and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for what it does not do.

## Quick start (demo)

Requires Node ≥ 22.15.

```bash
npm install
npm run build

# 1. the daemon (reads the repo, serves the inspector on 127.0.0.1)
npm run daemon                      # = tracenaut start examples/taskboard

# 2. the demo API, with the optional runtime agent
npm run demo:api

# 3. the demo web app
npm run demo:web                    # http://localhost:5173  (login: ada@example.com / analytical)
```

In the page:

| Do | To |
|---|---|
| **Alt + right-click** an element → *Inspect with TraceNaut* | see what it does, step by step |
| Click a step | what happens, the technologies, the data, the code that runs |
| Hover / click a dotted term, technology or piece of code notation | a short explanation; click keeps it open |
| **Layers** tab | the layers behind the element; select a layer or connection to see what it does |
| **How sure?** | what the certainty marks mean |
| **Watch it happen**, then use the page | record what really runs and compare it with the code |
| **Alt ⇧ I**, then click · **Alt ⇧ T** | pick an element · record your next action |
| **Guided / Technical** switch | plain journeys, or the full inspector |

The normal right-click menu is untouched. The optional Chrome extension (`packages/extension/dist`, load unpacked) adds *Inspect with TraceNaut* to the native menu.

## Use it on your own project

1. `tracenaut start <repo>`: optionally add a `tracenaut.json` describing services (otherwise they are detected from `package.json` files):
   ```json
   { "services": [ { "name": "web", "root": "web", "kind": "browser" },
                   { "name": "api", "root": "server", "kind": "node" } ],
     "editor": "vscode" }
   ```
2. Add the bundler plugin (development only):
   ```ts
   // Vite
   import tracenaut from '@tracenaut/vite-plugin';
   export default defineConfig({ plugins: [tracenaut(), react()] });

   // Next.js (next.config.ts) — Turbopack or webpack
   import withTraceNaut from '@tracenaut/next';
   export default withTraceNaut({ /* your config */ });
   ```
3. Optional, for server-side recording: `node --import @tracenaut/node-agent server.js`, or for Next.js `NODE_OPTIONS="--import @tracenaut/node-agent" next dev`.

TraceNaut never starts or executes your application; you run it as usual.

## Repository layout

```
packages/
  daemon/       CLI, local server, analysis engine (TypeScript compiler API), trace hub
  vite-plugin/  dev-only source locations + client injection (Vite)
  next-plugin/  the same for Next.js (Turbopack + webpack loader, CSP allowance in dev)
  instrument/   shared Babel plugin and probe runtime
  client/       in-page overlay (Preact, Shadow DOM)
  node-agent/   opt-in backend instrumentation (module hooks, AsyncLocalStorage, HTTP in/out,
                database wire protocols, SQLite drivers)
  extension/    optional MV3 extension for the native context menu
  protocol/     wire types, the evidence model, query redaction
  assets/       technology & concept registry, vendored logos (with licences), generated icons + gallery
examples/taskboard/   React + Express + SQLite demo used by the tests
tests/fixtures/frameworks/   small Fastify / Hono / koa-router / Next.js / axios / Prisma projects
tests/integration/   runtime checks against real libraries and real PostgreSQL (PGlite)
tests/safari/        real-Safari smoke test through safaridriver
tests/unit, tests/e2e
docs/ARCHITECTURE.md  decisions, trade-offs, roadmap
docs/LIMITATIONS.md   what TraceNaut does not do (yet)
docs/DESIGN.md        brand, icon system, hierarchy, layout and motion rules
docs/COVERAGE.md      technology × support level, real-repository validation
docs/perf/            benchmark and static-coverage reports (JSON)
scripts/icons/        icon generator, logo vendoring, gallery, PNG export
scripts/bench.mjs     performance benchmark · scripts/analyze-repo.mjs  static coverage of any repo
scripts/coverage.mjs  regenerates the coverage matrix from the registry
```

## Tests

```bash
npm test            # unit: instrumentation semantics, analysis precision, trace assembly
npm run test:e2e    # Playwright: daemon + instrumented API + Vite, driven in Chromium
```

The end-to-end suite starts its own isolated daemon, API and dev server. `tests/e2e/guided.spec.mjs` validates the guided experience against the questions a beginner should be able to answer: what happens when I click this, which language is responsible, what this syntax means, why this function runs, how the frontend talks to the backend, which technology handles the next step, where the code is, and what was observed versus only possible (including a wrong-password run that takes a different path). `tests/e2e/tracenaut.spec.mjs` covers the Technical-mode inspector and traces; `extension.spec.mjs` the browser extension; `edge.spec.mjs` failures and unusual use (daemon down or restarted, aborted and failing requests, secret query values, Shadow DOM, phone-sized screens, rapid mode switching, overlapping inspections, password fields). Unit tests also cover the framework fixtures and the Node agent's driver capture.

```bash
node tests/safari/smoke.mjs             # real Safari (enable Safari → Developer → Allow remote automation)
npm install --prefix tests/integration --ignore-scripts && node tests/integration/run-pg.mjs   # real PostgreSQL
npm run assets                          # regenerate icons, logo tiles, manifest, gallery
node scripts/bench.mjs --json out.json  # bundle size, cold start, latency, memory over 90 inspections
node scripts/analyze-repo.mjs <repo>    # what the static analysis finds in any repository
```
