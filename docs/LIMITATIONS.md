# Known limitations

TraceNaut tries hard never to claim more than it knows. These are the current boundaries. `docs/COVERAGE.md` lists, technology by technology, what is detected, analysed, observed and explained.

## Supported today
- **Frontend:** React (tested with React 19) built with Vite. Other JSX frameworks get source locations via the DOM fallback but no fiber-level handler confirmation. Next.js pages are analysed statically; the Vite plugin does not instrument a Next.js dev server (no webpack/Turbopack plugin yet), so Next.js apps cannot be inspected in the browser yet.
- **Backend routes (static):** Express (`express()`, `Router()`, mounts, sub-apps, middleware order), Fastify (`app.get`, `app.route({…})`, `register(plugin, { prefix })`), Hono (`new Hono()`, `app.route('/x', sub)`, `use('/x/*')`), koa-router (`new Router({ prefix })`, nested `use('/x', sub.routes())`), Next.js App Router (`app/**/route.ts`, groups and `[params]`) and `pages/api`.
- **Backend runtime:** Node.js ≥ 22.15 (uses `module.registerHooks`). Route identification at runtime uses Express's `req.route`; for other frameworks requests are still matched by method and path. SQL text is observed for `node:sqlite`, `better-sqlite3` and `pg`.
- **Languages:** TypeScript and JavaScript (analysed with the TypeScript compiler, `allowJs`).

## Static analysis
- Requests are recognised for `fetch`, `axios` (`axios.get/post/…`, `axios(config)`, `axios.request`, and instances made with `axios.create({ baseURL })`), through any number of wrapper functions (up to 5 levels) and through small URL-building helpers. Other HTTP clients (ky, superagent, `$fetch`, generated API clients, tRPC, GraphQL) are not recognised yet.
- When a URL helper puts a base address that is only known at runtime in front of the path (`getApiUrl(path)` reading configuration), TraceNaut assumes exactly that and matches routes by the end of their path. Such links are always **inferred**, and the note says what was assumed. A fixed request segment is never matched to a route parameter under this assumption.
- Next.js `middleware.ts`, `basePath`, rewrites and redirects in `next.config` are not read. Responses of Next.js and Hono handlers are found when they `return Response.json(…)`, `new Response(…)`, `NextResponse.*` or `c.json(…)` directly or through one helper function.
- Prisma calls (`x.<model>.<operation>()`) are recognised when the model is declared in a `.prisma` schema. Without the generated client they are **inferred** (names match the schema); the SQL that Prisma generates is never shown statically. Mongoose, Drizzle, Sequelize and TypeORM are detected as technologies but their queries are not analysed yet.
- SQL is found when it is written as text: passed to a database API (`prepare`, `query`, `exec`, …), to any helper (`rawQuery(\`select …\`)`), or prepared elsewhere and run through `stmt.get()/all()/run()`.
- Express `router.route('/x').get(...)` chains, dynamic route paths and routers built in loops are not extracted.
- Values that flow through React context, dependency injection or dynamic property access are followed only heuristically (marked **inferred**) or not at all (**unresolved**).
- A request is matched to a route assuming the path reaches the backend unchanged (e.g. a Vite proxy without rewrites). Proxy rewrites are not read.
- Higher-order and dynamically constructed handlers (`onClick={make(id)}`) show the factory, not the produced function.
- Elements drawn by library components (React Router's `<NavLink>`, UI kits) are reported as handled by that library; what the library does inside is not followed. "Watch it happen" shows which of the app's own code runs as a result.
- Measured on two public repositories (see `docs/COVERAGE.md`): full static analysis of a 1,000-file repo takes about 5 s and 670 MB, a 2,000-file Next.js repo about 6 s and 380 MB. Larger monorepos are not measured.

## Runtime tracing
- Only instrumented code appears: library internals (React, Express, React Router) are not traced, by design.
- A top-level call is presented as caused by your action only if it started while the browser was dispatching that action's events. Calls started by animation frames, timers or other events during the recording are shown as "Also ran during the recording", and long runs of them are folded. Effects that run after the redraw are labelled as such.
- The trace window ends after ~700 ms of inactivity with no pending requests (max 12 s). Work scheduled later (long timers, websockets) is not captured.
- Up to 5,000 calls per trace context are recorded; beyond that the count of dropped calls is reported.
- Only same-origin browser requests are correlated with the backend (a header is added only there). Cross-origin requests are listed without server detail.
- Requests that never get an answer (aborted, network failure) are shown as "No answer came back".
- Query parameters whose names suggest secrets (token, key, password, secret, auth, session, code, signature, jwt, credential, otp) are recorded as `•••`, in the browser and on the server.
- In React development mode, StrictMode double-invokes effects; traces faithfully show the duplicate requests.
- Generator functions and class constructors are not probed.
- Elements inside iframes cannot be inspected from the page around them. With the browser extension, choosing the menu item inside an iframe shows a message saying so (this path is not covered by the automated tests).

## Guided journeys
- Step titles and explanations are assembled from verified code structure (calls, request bodies, SQL text, ORM calls, response calls, imports), not written by AI. They are deliberately plain and sometimes generic ("The server's code handles it").
- A static journey shows everything the interaction's code can reach, in source order. Conditions are not modelled, except for alternative server answers (e.g. 200 / 401), which the Layers view draws as branches. Watch it happen shows the path actually taken.
- All SQL for one request is grouped into a single database step after the server's code; the exact interleaving is visible in Technical mode.
- Technologies are identified from the asset registry (129 technologies) using imports, file extensions, manifests and API usage. The "Built with" list on the home view reads manifests and files only; a dependency that is listed but unused still appears.
- The concept library (66 curated explanations, plus the registry's descriptions of 129 technologies) is English only. Terms outside it fall back to the registry's description or plain text.
- Observed and static journeys are compared by functions, routes and SQL text, so the "didn't run this time" list is precise to that level.
- AI explanations are not implemented (off by design until a privacy decision is made).

## Visual layer
- The element shown at the top of a journey is a simplified drawing from the element's live colours, border and text, not a screenshot. See-through elements are drawn on the page colour behind them. Images, icons and complex layouts inside the element are not reproduced. Input values are never read; placeholders or labels are shown instead.
- The Layers view draws three places (browser, server, database). Each request gets its own lane (the first two are shown, the rest behind "Show more"); a place whose steps are all unknown is drawn as an outline.
- Official logos come from Simple Icons 16.35.0 and keep their original artwork. Logos under non-commercial licences are excluded (Vue.js, Sass); technologies without a logo use TraceNaut's conceptual icons. Logos identify technologies; they do not imply endorsement.
- Automated tests run in Chromium. The panel has not been run in Safari by the test suite (Safari automation needs "Allow remote automation" enabled, or a Playwright WebKit download).

## Security model
- The daemon trusts any page on `localhost` / `127.0.0.1` that presents the session token; the token is injected into your dev page by the Vite plugin. Do not expose the dev server publicly while the daemon runs. When the daemon restarts, open pages hold an old token; the panel says to reload.
- TraceNaut never executes repository code itself. Your app is instrumented only when *you* add the Vite plugin and/or start Node with the agent.
- If TraceNaut cannot parse a file, the Vite plugin serves it unchanged (and logs one line); the app keeps working, that file just cannot be inspected.
