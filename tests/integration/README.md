# Runtime integration checks

These run TraceNaut's daemon and Node agent against **real** libraries and a **real PostgreSQL**
(PGlite: PostgreSQL compiled to WebAssembly, served over TCP), the same way the browser client
drives a recording (trace header + finish call). They are separate from the unit and e2e suites
because they need extra packages (about 50 MB) that are not TraceNaut dependencies.

```bash
npm run build
npm install --prefix tests/integration --ignore-scripts   # once
node tests/integration/run-pg.mjs     # pg Pool, postgres.js, Drizzle; concurrency, errors, a second service
node tests/integration/run-fw.mjs     # Fastify, Hono, Koa: routes confirmed by their handler running
node tests/integration/overhead.mjs   # request latency without the agent, idle, and while recording
```

`pg-app/server/app.js` also runs an untraced background job every 40 ms; its statements must
never appear under a traced request. Ports used: 5433 (database), 4600–4615 (daemons, apps).
