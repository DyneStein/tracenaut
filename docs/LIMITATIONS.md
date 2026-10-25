# Known limitations

TraceNaut tries hard never to claim more than it knows. These are the current boundaries. `docs/COVERAGE.md` lists, technology by technology, what is detected, analysed, observed and explained, and which real applications were run.

## Supported today
- **In the browser:** React apps built with **Vite** (`@tracenaut/vite-plugin`) or **Next.js** (`@tracenaut/next`, Turbopack and webpack, Next 15 and 16). Other JSX frameworks get source locations via the DOM fallback but no fiber-level handler confirmation. Vue, Svelte, Angular and Remix/React Router framework mode have no bundler plugin yet.
- **Server routes (static):** Express, Fastify, Hono, koa-router, Next.js (route files, pages, Server Actions, `pages/api`).
- **Server at runtime:** any Node.js ≥ 22.15 HTTP server (`node --import @tracenaut/node-agent`, or `NODE_OPTIONS` for `next dev`). Which route handled a request is confirmed by seeing its handler run (Express also reports it directly); otherwise it is only matched by method and path and shown as likely.
- **Databases at runtime:** statement text from SQLite (`node:sqlite`, `better-sqlite3`), and from the wire protocol for PostgreSQL (any in-process driver or ORM, validated with pg, postgres.js, Drizzle and Prisma 7's pg adapter against real PostgreSQL), MySQL, MongoDB and Redis (protocol-tested only, not against real servers yet).
- **Languages:** TypeScript and JavaScript (analysed with the TypeScript compiler, `allowJs`).

## Static analysis
- Requests are recognised for `fetch` and `axios` through any number of wrapper functions (up to 5 levels) and URL-building helpers; TanStack Query's `mutate()/mutateAsync()` are followed to the `mutationFn` given to `useMutation` (directly or inside the app's own hook). Other clients (ky, superagent, `$fetch`, generated API clients, tRPC, GraphQL) are not recognised yet.
- A value captured from an enclosing function (`useUpdateQuery(path)` → `post(path)` inside a callback) is not substituted with the caller's argument, so such addresses show as "known when the code runs". Recordings show them in full.
- When a URL helper adds a base address known only at runtime, routes are matched by the end of their path and every such link is **likely**. Data requests are never matched to Next.js pages.
- Functions handed to a library (`useDebouncedCallback(fn)`, `debounce(fn)`), handlers passed to library components (`<Form onSubmit={fn}>`), and form actions (`<form action={fn}>`, `useActionState(fn)`, `fn.bind(…)`) are followed; when a library decides when to call them, the link is **likely**.
- Router navigation is recognised for Next.js (`useRouter()` methods, `redirect()`), React Router (`navigate` from `useNavigate`) and `location.assign/replace`, by type; other routers are not.
- Next.js `middleware.ts`/`proxy.ts`, `basePath`, rewrites and redirects in `next.config` are not read. Prisma calls are matched against `schema.prisma` (likely without the generated client); Mongoose, Sequelize and TypeORM queries are not analysed statically (Drizzle and Prisma SQL are seen at runtime).
- Express `router.route('/x').get(...)` chains, dynamic route paths and routers built in loops are not extracted. Proxy rewrites between front end and back end are not read.
- Higher-order handlers (`onClick={make(id)}`) show the factory, not the produced function.

## Runtime tracing
- Only instrumented code appears: library internals (React, Next.js, routers, database libraries) are not traced, by design.
- A top-level call is shown as caused by your action only if it started while the action's events were being dispatched, or if the element's own code leads to it (a debounce, a timer it sets: shown as **likely**). Animation frames, timers and effects that send nothing are folded as "also ran during the recording".
- A database statement sent while the request's code is on the stack is linked as **happened**; one a driver sends later from its queue is **likely** (driver batching could mix requests); one sent from the connection's own queue while several requests are in progress is listed separately as "also ran, not linked". Unrelated background statements are dropped.
- An action that loads a completely new page is still recorded up to that point; the next page finishes the recording and says where it stopped. Recordings are lost if the new page is on another origin or TraceNaut is not loaded there.
- WebSocket messages are counted per connection (never read). Incoming messages are only counted on connections opened after TraceNaut loaded.
- Server-side recording of Next.js needs the agent in the dev server's process (`NODE_OPTIONS`); Prisma's older native query engine and other native drivers do not go through Node sockets and are invisible.
- The trace window ends after ~700 ms of inactivity with no pending requests (max 12 s). Up to 5,000 calls per trace context are recorded.
- Only same-origin browser requests are correlated with the backend. Calls between local services are followed (the trace header is only sent to localhost); calls to other hosts are listed without their side.
- Query parameters whose names suggest secrets, string literals in SQL, quoted parts of database error messages, bind parameters, passwords, documents, keys and message contents are never recorded.
- Generator functions and class constructors are not probed. Elements inside iframes cannot be inspected from the page around them.

## Guided journeys
- Titles and explanations are assembled from verified structure and recordings, never written by AI. A static journey shows everything the code can reach (all branches); several possible navigations are not narrowed to one. Watch it happen shows the path actually taken.
- Technologies come from the registry (129 technologies) or, for any other package, from that package's own `package.json`. Package-described libraries are listed with the step that calls them, not in the place headers.
- The concept library (about 70 curated explanations) is English only.
- AI explanations are not implemented (off by design until a privacy decision is made).

## Visual layer
- The element drawing at the top is a simplified rendering from live styles (see-through elements on their page colour), not a screenshot. Input values are never read.
- Official logos are unaltered Simple Icons artwork; thin wordmarks (Express, Koa) look faint at 14 px. Logos under non-commercial licences are excluded.

## Browsers
- Chromium: full automated suite (unit + 40 e2e tests). Safari 26.5: real-Safari smoke test (`node tests/safari/smoke.mjs`, 9 checks: Alt+right-click menu, journey, icons, step details, concept cards, Layers, Watch it happen, password safety, scrolling), run on the demo app; Next.js apps were exercised in Chromium only. Firefox is untested.

## Security model
- The daemon trusts any local page that presents the session token, which bundler plugins inject into your dev page. The token is kept across daemon restarts for the same repository (owner-only file); `tracenaut start --new-token` replaces it. Do not expose the dev server publicly while the daemon runs.
- In development, `@tracenaut/next` adds `http://127.0.0.1:*` to the app's Content-Security-Policy headers set in `next.config` (`headers()`), so the client can load. A CSP set by middleware or a proxy is not changed, and then TraceNaut cannot load.
- TraceNaut never executes repository code itself. Your app is instrumented only when you add a plugin and/or start Node with the agent. Files it cannot parse are served unchanged.
