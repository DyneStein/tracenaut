// Static coverage report for a repository: what TraceNaut's analysis finds.
//   node scripts/analyze-repo.mjs <repo> [--json out.json]
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { Analyzer, loadWorkspace } from '../packages/daemon/dist/analysis.js';

const repo = process.argv[2];
const t0 = Date.now();
const ws = loadWorkspace(repo);
const a = new Analyzer(ws);
const report = { repo, services: ws.services.map((s) => `${s.name}:${s.kind}:${s.root}`), timings: {}, routes: {}, requests: {}, sql: {} };

const tr = Date.now();
const routes = a.allRoutes();
report.timings.routesMs = Date.now() - tr;
report.routes.count = routes.length;
report.routes.unmounted = routes.filter((r) => !r.mounted).length;
report.routes.withMiddleware = routes.filter((r) => r.middleware.length > 0).length;
report.routes.sample = routes.slice(0, 8).map((r) => `${r.method} ${r.path} (${r.file}:${r.line}) mw=[${r.middleware.map((m) => m.expr.getText().slice(0, 30)).join(', ')}]`);

// Every function in browser services: what requests do they make, and do they match a route?
const tq = Date.now();
const reqs = [];
for (const s of ws.services.filter((x) => x.kind === 'browser')) {
  const project = a.project(s.name);
  for (const sf of project.userSourceFiles()) {
    const visit = (n) => {
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) {
        const node = a.fnNode(n);
        for (const r of a.outgoing(n)) if (r.kind === 'requests') reqs.push({ from: `${node.source.file}:${node.source.line}`, label: r.target.label, evidence: r.evidence, id: r.target.id });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}
const uniq = new Map(reqs.map((r) => [r.id, r]));
const list = [...uniq.values()];
let matched = 0;
const methods = {};
for (const r of list) {
  const routesTo = a.flowRelations(r.id);
  r.routes = routesTo.length;
  if (routesTo.length) matched++;
  const m = r.label.split(' ')[0];
  methods[m] = (methods[m] ?? 0) + 1;
}
report.timings.requestsMs = Date.now() - tq;
report.requests = {
  callSites: list.length,
  byEvidence: list.reduce((o, r) => ((o[r.evidence] = (o[r.evidence] ?? 0) + 1), o), {}),
  byMethod: methods,
  matchedToRoute: matched,
  sample: list.slice(0, 12).map((r) => `${r.label} [${r.evidence}] → ${r.routes} route(s)  (${r.from})`),
  unmatchedSample: list.filter((r) => !r.routes).slice(0, 10).map((r) => `${r.label} [${r.evidence}]  (${r.from})`),
};

// SQL: per route handler, are queries visible?
let handlersWithSql = 0;
for (const r of routes) {
  const rels = a.flowRelations(`route:${r.file}:${r.line}:${r.col}`);
  const h = rels.find((x) => x.kind === 'handles');
  if (!h || !h.target.expandable) continue;
  const seen = new Set();
  const stack = [h.target.id];
  let found = false;
  while (stack.length && seen.size < 40 && !found) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const rel of a.flowRelations(id)) {
      if (rel.kind === 'queries') found = true;
      else if (rel.kind === 'calls' && rel.target.expandable && rel.target.id.startsWith('fn:')) stack.push(rel.target.id);
    }
  }
  if (found) handlersWithSql++;
}
report.sql.routeHandlersReachingSql = `${handlersWithSql} / ${routes.length}`;
report.timings.totalMs = Date.now() - t0;
report.memoryMB = Math.round(process.memoryUsage().rss / 1048576);
console.log(JSON.stringify(report, null, 2));
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2));
