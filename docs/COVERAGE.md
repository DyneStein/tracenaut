# Coverage

What TraceNaut can do, technology by technology, and how it was checked on real code. Support levels are declared in `packages/assets/src/registry.mjs` and kept separate on purpose: having an icon is not analysis.

| Level | Meaning |
|---|---|
| Icon | TraceNaut can show it (official logo tile or TraceNaut icon). |
| Detect | TraceNaut can tell, from repository evidence, that a project uses it ("Built with" on the home view). |
| Static | TraceNaut analyses its code structure (calls, routes, requests, queries). |
| Runtime | TraceNaut observes it while the app runs ("Watch it happen"). |
| Trace | TraceNaut links it across places, e.g. request → route → SQL. |
| Explain | A plain-language explanation is available. |

## What each analysed technology means in practice

| Area | Static | Runtime |
|---|---|---|
| React + Vite | Element → JSX (exact), component chain, handlers incl. bubbling, form submission, props and spreads; elements drawn by library components are attributed to the library | Function calls of the app's own code, re-renders, effects; calls are marked as caused only if they started during the event's dispatch |
| HTTP clients | `fetch`, `axios` (methods, config calls, `axios.create({ baseURL })`); wrappers up to 5 levels deep; URL-builder helpers inlined; unknown runtime base addresses assumed explicitly (inferred) | All `fetch`/XHR requests during a recording, with status, duration, failures; sensitive query values redacted |
| Express | Routes, mount prefixes, sub-apps, path-scoped middleware in order, responses (`res.status().json()`, cookies) | Matched route (`req.route`), server calls, SQL |
| Fastify, Hono, koa-router | Routes incl. plugins/sub-apps/prefixes, middleware where declared, responses (`reply.code().send()`, `c.json()`, `ctx.status/body`) | Server calls and SQL through the Node agent (route identified by method + path); not exercised on a real app yet |
| Next.js | `app/**/route.ts` (groups, `[param]`, `[...rest]`) and `pages/api`; responses via `Response.json` / `NextResponse` (one helper level) | Not supported yet (no instrumentation plugin for Next's bundler) |
| SQL | SQL text passed to database APIs or helpers, statements prepared elsewhere, template SQL with runtime parts | `node:sqlite`, `better-sqlite3`, `pg`: statement text, rows, errors; parameter values never read |
| Prisma | `x.<model>.<op>()` matched to models in `.prisma` schemas; inferred without the generated client | Not observed as Prisma; the SQL it generates is seen only when it goes through an observed driver |

`pg` runtime capture is tested against a stand-in module with pg's API shape (`tests/unit/agent-drivers.test.mjs`), not against a PostgreSQL server. `better-sqlite3` capture is tested the same way and was also observed on a real app (below).

## Validation on public repositories

Both repositories were cloned into an isolated scratch directory; no install scripts were run (`npm install --ignore-scripts`, then one native rebuild for better-sqlite3). The static reports are produced by `node scripts/analyze-repo.mjs <repo> --json <out>` and stored in `docs/perf/`.

| | [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) @ `3cb22ae4` (MIT) | [umami](https://github.com/umami-software/umami) @ `559e3c60` (MIT) |
|---|---|---|
| Stack | React + Vite client, Express (CommonJS), better-sqlite3, ws | Next.js App Router, Prisma, raw SQL, React Query |
| Files read | 1,004 | 2,009 |
| Server routes found | 128 | 203 (Next.js route files) |
| Request call sites | 111 | 135 |
| Requests matched to a route | 110 / 111 (before this work: 47 / 109) | 76 / 135 |
| Methods resolved | all 111 (before: 103 of 109 reported as GET, most wrongly) | 134 of 135 |
| Route handlers reaching the database | 76 / 128 (before: 33) | 198 / 203 (Prisma + raw SQL) |
| Full analysis time / memory | 4.3 s / 673 MB (before: 47 s) | 5.2 s / 411 MB |
| Runtime | Ran in a sandbox (separate HOME, data dir, ports); three interactions recorded | Not run (needs PostgreSQL) |

Unmatched requests are left unmatched on purpose: in umami they are the generic wrappers themselves, requests to static files in `public/` (translation files), and paths with a runtime segment where a fixed one would be needed (`/websites/{id}/{feature}`), which could fit several routes.

### Runtime on Claude-Code-Agent-Monitor

The app ran with the TraceNaut Vite plugin and the Node agent, with `HOME`, `CLAUDE_HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME` and the app's data paths pointed at a scratch folder. The app installs Claude Code hooks at start-up; they were written to the scratch folder and the real `~/.claude/settings.json` was left unchanged.

| Interaction | Static journey | Recording |
|---|---|---|
| Onboarding "Continue to dashboard" | click → `continueFromProviderChoice` → `GET /api/settings/info` → Express route behind `hostGuard` → SQL → 403/401/200 | Confirmed; 6 further requests seen running |
| Dashboard "Refresh" | `GET /api/stats`, `/api/agents` (×2), `/api/events`, … each matched to its route with SQL | 10 predicted links confirmed, better-sqlite3 statements captured with row counts |
| Sidebar "Sessions" (React Router `<NavLink>`) | "NavLink from react-router handles it: it leads to /sessions" | Page redraw, effects and the requests they send; unrelated animation-frame code folded as "also ran" |

Issues found this way and fixed: server functions outside the configured server folder were shown in the browser zone of recordings; an element drawn by a router library was reported as doing nothing; an animation-frame callback was presented as the first thing the click ran; the headline implied the click itself sent a request that a later effect sent.

## Technology matrix

Generated by `node scripts/coverage.mjs`.

| Technology | Kind | Icon | Detect | Static | Runtime | Trace | Explain |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Programming languages** | |  |  |  |  |  |  |
| JavaScript | language | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| TypeScript | language | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| TSX | language | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Python | language | ✓ | ✓ | · | · | · | ✓ |
| Java ¹ | language | ✓ | ✓ | · | · | · | ✓ |
| Kotlin | language | ✓ | ✓ | · | · | · | ✓ |
| C | language | ✓ | ✓ | · | · | · | ✓ |
| C++ | language | ✓ | ✓ | · | · | · | ✓ |
| C# ¹ | language | ✓ | ✓ | · | · | · | ✓ |
| Go | language | ✓ | ✓ | · | · | · | ✓ |
| Rust | language | ✓ | ✓ | · | · | · | ✓ |
| Ruby | language | ✓ | ✓ | · | · | · | ✓ |
| PHP | language | ✓ | ✓ | · | · | · | ✓ |
| Swift | language | ✓ | ✓ | · | · | · | ✓ |
| Dart | language | ✓ | ✓ | · | · | · | ✓ |
| HTML | language | ✓ | ✓ | · | · | · | ✓ |
| CSS | language | ✓ | ✓ | · | · | · | ✓ |
| Sass ¹ | language | ✓ | ✓ | · | · | · | ✓ |
| SQL ¹ | language | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GraphQL | protocol | ✓ | ✓ | · | · | · | ✓ |
| Bash | language | ✓ | ✓ | · | · | · | ✓ |
| Scala | language | ✓ | ✓ | · | · | · | ✓ |
| Elixir | language | ✓ | ✓ | · | · | · | ✓ |
| Lua | language | ✓ | ✓ | · | · | · | ✓ |
| R | language | ✓ | ✓ | · | · | · | ✓ |
| Zig | language | ✓ | ✓ | · | · | · | ✓ |
| WebAssembly | language | ✓ | ✓ | · | · | · | ✓ |
| **Frontend** | |  |  |  |  |  |  |
| React | library | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Next.js | framework | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| Vue ¹ | framework | ✓ | ✓ | · | · | · | ✓ |
| Nuxt | framework | ✓ | ✓ | · | · | · | ✓ |
| Angular | framework | ✓ | ✓ | · | · | · | ✓ |
| Svelte | framework | ✓ | ✓ | · | · | · | ✓ |
| Solid | library | ✓ | ✓ | · | · | · | ✓ |
| Preact | library | ✓ | ✓ | · | · | · | ✓ |
| Astro | framework | ✓ | ✓ | · | · | · | ✓ |
| React Router / Remix | framework | ✓ | ✓ | · | · | · | ✓ |
| Tailwind CSS | framework | ✓ | ✓ | · | · | · | ✓ |
| Bootstrap | framework | ✓ | ✓ | · | · | · | ✓ |
| MUI | library | ✓ | ✓ | · | · | · | ✓ |
| Redux | library | ✓ | ✓ | · | · | · | ✓ |
| axios ¹ | library | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| TanStack Query | library | ✓ | ✓ | · | · | · | ✓ |
| jQuery | library | ✓ | ✓ | · | · | · | ✓ |
| Three.js | library | ✓ | ✓ | · | · | · | ✓ |
| D3 ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| i18next ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| **Backend** | |  |  |  |  |  |  |
| Node.js | runtime | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bun | runtime | ✓ | ✓ | · | · | · | ✓ |
| Deno | runtime | ✓ | ✓ | · | · | · | ✓ |
| Express | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fastify | framework | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| Koa | framework | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| Hono | framework | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| NestJS | framework | ✓ | ✓ | · | · | · | ✓ |
| tRPC | library | ✓ | ✓ | · | · | · | ✓ |
| Apollo GraphQL | library | ✓ | ✓ | · | · | · | ✓ |
| FastAPI | framework | ✓ | ✓ | · | · | · | ✓ |
| Django | framework | ✓ | ✓ | · | · | · | ✓ |
| Flask | framework | ✓ | ✓ | · | · | · | ✓ |
| Spring Boot | framework | ✓ | ✓ | · | · | · | ✓ |
| Laravel | framework | ✓ | ✓ | · | · | · | ✓ |
| Ruby on Rails | framework | ✓ | ✓ | · | · | · | ✓ |
| ASP.NET | framework | ✓ | ✓ | · | · | · | ✓ |
| **Databases & data access** | |  |  |  |  |  |  |
| SQLite | database | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL | database | ✓ | ✓ | ✓ | ✓ | · | ✓ |
| MySQL | database | ✓ | ✓ | ✓ | · | · | ✓ |
| MariaDB | database | ✓ | ✓ | · | · | · | ✓ |
| MongoDB | database | ✓ | ✓ | · | · | · | ✓ |
| Redis | database | ✓ | ✓ | · | · | · | ✓ |
| Firebase | platform | ✓ | ✓ | · | · | · | ✓ |
| Supabase | platform | ✓ | ✓ | · | · | · | ✓ |
| DynamoDB ¹ | database | ✓ | ✓ | · | · | · | ✓ |
| Elasticsearch | database | ✓ | ✓ | · | · | · | ✓ |
| Apache Cassandra | database | ✓ | ✓ | · | · | · | ✓ |
| Neo4j | database | ✓ | ✓ | · | · | · | ✓ |
| Prisma | library | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| Drizzle ORM | library | ✓ | ✓ | · | · | · | ✓ |
| Sequelize | library | ✓ | ✓ | · | · | · | ✓ |
| Mongoose | library | ✓ | ✓ | ✓ | · | · | ✓ |
| TypeORM | library | ✓ | ✓ | · | · | · | ✓ |
| Knex.js | library | ✓ | ✓ | · | · | · | ✓ |
| **Infrastructure & delivery** | |  |  |  |  |  |  |
| Docker | platform | ✓ | ✓ | · | · | · | ✓ |
| Kubernetes | platform | ✓ | ✓ | · | · | · | ✓ |
| NGINX | service | ✓ | ✓ | · | · | · | ✓ |
| Traefik | service | ✓ | ✓ | · | · | · | ✓ |
| Kong Gateway | service | ✓ | ✓ | · | · | · | ✓ |
| GitHub Actions | service | ✓ | ✓ | · | · | · | ✓ |
| GitLab CI | service | ✓ | ✓ | · | · | · | ✓ |
| CircleCI | service | ✓ | ✓ | · | · | · | ✓ |
| Jenkins | service | ✓ | ✓ | · | · | · | ✓ |
| Terraform | tool | ✓ | ✓ | · | · | · | ✓ |
| Vercel | platform | ✓ | ✓ | · | · | · | ✓ |
| Netlify | platform | ✓ | ✓ | · | · | · | ✓ |
| Cloudflare | platform | ✓ | ✓ | · | · | · | ✓ |
| AWS ¹ | platform | ✓ | ✓ | · | · | · | ✓ |
| Microsoft Azure ¹ | platform | ✓ | ✓ | · | · | · | ✓ |
| Google Cloud | platform | ✓ | ✓ | · | · | · | ✓ |
| Prometheus | service | ✓ | ✓ | · | · | · | ✓ |
| Grafana | service | ✓ | ✓ | · | · | · | ✓ |
| **Development tools** | |  |  |  |  |  |  |
| Vite | tool | ✓ | ✓ | · | ✓ | · | ✓ |
| webpack | tool | ✓ | ✓ | · | · | · | ✓ |
| Babel | tool | ✓ | ✓ | · | · | · | ✓ |
| Git | tool | ✓ | ✓ | · | · | · | ✓ |
| GitHub | platform | ✓ | ✓ | · | · | · | ✓ |
| npm | tool | ✓ | ✓ | · | · | · | ✓ |
| pnpm | tool | ✓ | ✓ | · | · | · | ✓ |
| Yarn | tool | ✓ | ✓ | · | · | · | ✓ |
| ESLint | tool | ✓ | ✓ | · | · | · | ✓ |
| Prettier | tool | ✓ | ✓ | · | · | · | ✓ |
| OpenAPI | data-format | ✓ | ✓ | · | · | · | ✓ |
| Sentry | service | ✓ | ✓ | · | · | · | ✓ |
| **Authentication** | |  |  |  |  |  |  |
| JSON Web Tokens | data-format | ✓ | ✓ | · | · | · | ✓ |
| Passport | library | ✓ | ✓ | · | · | · | ✓ |
| Auth0 | service | ✓ | ✓ | · | · | · | ✓ |
| Clerk | service | ✓ | ✓ | · | · | · | ✓ |
| Auth.js ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| Keycloak | service | ✓ | ✓ | · | · | · | ✓ |
| bcrypt ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| **Messaging & real time** | |  |  |  |  |  |  |
| Socket.IO | library | ✓ | ✓ | · | · | · | ✓ |
| WebSocket ¹ | protocol | ✓ | ✓ | · | · | · | ✓ |
| RabbitMQ | service | ✓ | ✓ | · | · | · | ✓ |
| Apache Kafka | service | ✓ | ✓ | · | · | · | ✓ |
| BullMQ ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| **Testing** | |  |  |  |  |  |  |
| Jest | tool | ✓ | ✓ | · | · | · | ✓ |
| Vitest | tool | ✓ | ✓ | · | · | · | ✓ |
| Playwright ¹ | tool | ✓ | ✓ | · | · | · | ✓ |
| Cypress | tool | ✓ | ✓ | · | · | · | ✓ |
| Storybook | tool | ✓ | ✓ | · | · | · | ✓ |

129 technologies · Icon 129 · Detect 129 · Static 17 · Runtime 10 · Trace 14 · Explain 129

¹ No official logo is used (licence or availability); TraceNaut's conceptual icon is shown instead.
