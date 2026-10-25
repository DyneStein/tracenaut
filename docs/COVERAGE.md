# Coverage

What TraceNaut can do, technology by technology, and how it was checked on real code. Support levels are declared in `packages/assets/src/registry.mjs` and kept separate on purpose: having an icon is not analysis.

| Level | Meaning |
|---|---|
| Icon | TraceNaut can show it (official logo tile or TraceNaut icon). |
| Detect | TraceNaut can tell, from repository evidence, that a project uses it ("Built with" on the home view). |
| Static | TraceNaut analyses its code structure (calls, routes, requests, queries). |
| Runtime | TraceNaut observes it while the app runs ("Watch it happen"), validated on a running app. |
| Trace | TraceNaut links it across places, e.g. request → route → SQL. |
| Explain | A plain-language explanation is available. |

## How TraceNaut avoids needing one adapter per technology

Most of what TraceNaut observes is read at boundaries every stack has to pass through, so it works for libraries it has never heard of:

| Boundary | What it gives | Works for |
|---|---|---|
| JSX and functions, instrumented at build time (Babel, as a Vite plugin or a Next.js loader) | element → source, which functions ran, in what order | any React code compiled by Vite, Turbopack or webpack |
| DOM events and their dispatch phase | which calls your action ran, and which only happened during the recording | any UI library |
| `fetch`/XHR/WebSocket in the page | requests, answers, live-connection message counts | any HTTP or WebSocket client |
| Node's HTTP server and client (`diagnostics_channel`) | requests reaching a server, requests it sends on (incl. to another local service) | Express, Fastify, Hono, Koa, Next.js, plain `http`, … |
| Database wire protocols on sockets | statement text (literals hidden), row counts, errors | PostgreSQL (any driver: pg, postgres.js, Drizzle, Knex, Prisma via a JS adapter, …), MySQL, MongoDB, Redis |
| Installed packages' own `package.json` | name and description of any library | every npm package |

Technology knowledge (the registry, curated explanations, framework route syntax, a few library contracts such as TanStack Query's `mutationFn`) is enrichment on top. When it is missing, journeys still show what ran and what was sent; the explanation is then the library's own description.

## Real applications

| Application | Revision | Stack | How it ran |
|---|---|---|---|
| [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (MIT) | `3cb22ae4` | React + Vite, Express, better-sqlite3, WebSocket | sandboxed HOME and data dirs; Vite plugin + agent |
| [next-learn dashboard](https://github.com/vercel/next-learn/tree/main/dashboard/final-example) (MIT) | `bb255844` | Next.js 15.5 (Turbopack), Server Components, Server Actions, postgres.js, PostgreSQL | `@tracenaut/next` + agent; PGlite seeded with the app's own data |
| [umami](https://github.com/umami-software/umami) (MIT) | `559e3c60` | Next.js 16.4 (Turbopack), Prisma 7 + `@prisma/adapter-pg`, TanStack Query, a UI kit, CSP headers; pnpm workspace | `@tracenaut/next` + agent; PGlite with the repo's 27 migrations |
| Validation apps in `tests/integration` (own code) | — | Fastify 5, Hono 4, Koa 3, pg, postgres.js, Drizzle, a second local service | `node tests/integration/run-*.mjs` |

Test-environment adaptations (scratch copies only): the dashboard's `ssl: 'require'` was made configurable because PGlite's TCP server has no TLS; its seed route was replaced by a single-connection seed of the same placeholder data (PGlite serialises connections and the route opens several inside a transaction); each app's Next.js/Vite config was wrapped with the TraceNaut plugin.

### Interactions traced end to end

| App | Interaction | Static journey | Recording |
|---|---|---|---|
| dashboard | sidebar link (Next `<Link>`) | Next.js's `<Link>` handles it, leads to `/dashboard/invoices` | RSC request → page `/dashboard/invoices` → its Server Components → SQL reads (likely) → redraw |
| dashboard | "Create Invoice" form (Server Action) | submit → Server Action `createInvoice()` → INSERT invoices → result, redirect | same, plus the server asking itself for the next page, 303 answer; the invoice really appears |
| dashboard | Delete icon inside a submit button | submit → Server Action `deleteInvoice()` (via `.bind`) → DELETE invoices | — |
| dashboard | search box (debounced) | change handler → debounced function (likely) → Next router changes the page | "a moment later, the code it scheduled" → RSC request → page → SQL → redraw |
| umami | login form (library `<Form onSubmit>`, TanStack `useMutation`) | handleSubmit (likely) → mutationFn → POST (address set at runtime) → two possible navigations | POST /api/auth/login → route → Prisma's SQL via pg (two_factor_auth, team, user) → full page load, recording finished on the new page |
| agent monitor | onboarding button, Refresh, React Router link | requests and routes for each; NavLink reported as React Router | 10 predicted links confirmed for Refresh; better-sqlite3 statements |
| integration apps | Fastify plugin route, Hono sub-app, Koa nested router | routes with prefixes and middleware | each route confirmed by its handler running, with its SQL |
| integration apps | pg Pool / postgres.js / Drizzle, concurrent and overlapping requests, SQL error, server → second service | — | every statement under the right request; queued ones marked likely; background job never linked |

### Correctness of discovered links (manually verified samples)

Static request → server-route links, deterministic samples checked by reading the client call and the route definition:

| Repository | Links found | Sample | Correct | Wrong |
|---|---|---|---|---|
| Agent monitor (Express) | 116 | 15 | 15 | 0 |
| umami (Next.js) — before fix | 96 | 15 | 11 | 4 (requests matched to *pages*) |
| umami (Next.js) — after fix | 76 | 20 | 20 | 0 |

The umami false positives were found by this sampling and fixed: data requests written in code are no longer matched to Next.js pages (pages are only matched for runtime navigation requests). Runtime journeys above were each compared with the source; incorrect runtime links found during validation (an animation frame presented as caused by a click, server code shown in the browser, a request credited to the click instead of a later effect, a link drawn as two lanes, a "page" request read as "nothing happens") were fixed and have regression tests.

### Static coverage numbers

Produced by `node scripts/analyze-repo.mjs <repo> --json <out>`, stored in `docs/perf/`:

| | Agent monitor | umami | dashboard |
|---|---|---|---|
| Routes (incl. Next.js pages) | 128 | 263 | 9 |
| Request call sites / linked to a route | 111 / 110 | 135 / 76 | 0 (the app uses Server Actions and Server Components, not fetch) |
| Route handlers reaching the database | 76 / 128 | 202 / 263 | 6 / 9 |
| Full analysis | 4.4 s, 681 MB | 9.5 s, 707 MB | 1.2 s |

## Technology matrix

Generated by `node scripts/coverage.mjs`. MySQL, MongoDB and Redis statement capture is implemented and tested on hand-built protocol messages, but not yet against real servers, so they are not marked Runtime.

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
| Next.js | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
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
| TanStack Query | library | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| jQuery | library | ✓ | ✓ | · | · | · | ✓ |
| Three.js | library | ✓ | ✓ | · | · | · | ✓ |
| D3 ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| i18next ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| **Backend** | |  |  |  |  |  |  |
| Node.js | runtime | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bun | runtime | ✓ | ✓ | · | · | · | ✓ |
| Deno | runtime | ✓ | ✓ | · | · | · | ✓ |
| Express | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fastify | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Koa | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hono | framework | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
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
| Prisma | library | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Drizzle ORM | library | ✓ | ✓ | · | ✓ | · | ✓ |
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
| WebSocket ¹ | protocol | ✓ | ✓ | · | ✓ | · | ✓ |
| RabbitMQ | service | ✓ | ✓ | · | · | · | ✓ |
| Apache Kafka | service | ✓ | ✓ | · | · | · | ✓ |
| BullMQ ¹ | library | ✓ | ✓ | · | · | · | ✓ |
| **Testing** | |  |  |  |  |  |  |
| Jest | tool | ✓ | ✓ | · | · | · | ✓ |
| Vitest | tool | ✓ | ✓ | · | · | · | ✓ |
| Playwright ¹ | tool | ✓ | ✓ | · | · | · | ✓ |
| Cypress | tool | ✓ | ✓ | · | · | · | ✓ |
| Storybook | tool | ✓ | ✓ | · | · | · | ✓ |

129 technologies · Icon 129 · Detect 129 · Static 18 · Runtime 17 · Trace 15 · Explain 129

¹ No official logo is used (licence or availability); TraceNaut's conceptual icon is shown instead.
