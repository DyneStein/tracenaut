import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { FrontendTracePayload, InspectRequest, JourneyResult, StackResult, StatusResult } from '@tracenaut/protocol';
import type { Workspace } from './workspace.js';
import { Analyzer } from './analysis/analyzer.js';
import { RuntimeHub } from './runtime/hub.js';
import { JourneyBuilder } from './journey/flow.js';
import { detectStack } from './stack.js';

const CLIENT_BUNDLE = fileURLToPath(new URL('../../client/dist/client.js', import.meta.url));
const ASSETS = fileURLToPath(new URL('../../assets/dist/', import.meta.url));

/** Version of the generated asset set (changes whenever any icon changes). */
export function assetsVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(`${ASSETS}manifest.json`, 'utf8')).version;
  } catch {
    return undefined;
  }
}
const MAX_BODY = 4 * 1024 * 1024;

/** Only local origins (dev servers) and browser extensions may call the daemon. */
function allowedOrigin(origin: string | undefined) {
  if (!origin) return undefined;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
  return undefined;
}

function tokensEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createDaemon(ws: Workspace, token: string) {
  let stackCache: { at: number; result: StackResult } | undefined;
  const analyzer = new Analyzer(ws);
  const hub = new RuntimeHub(ws, analyzer);
  const journeys = new JourneyBuilder(analyzer);

  const server = http.createServer(async (req, res) => {
    const origin = allowedOrigin(req.headers.origin);
    if (req.headers.origin && !origin) {
      res.writeHead(403).end('Origin not allowed');
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-tracenaut-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/client.js' || url.pathname === '/client.js.map') {
        const file = url.pathname.endsWith('.map') ? `${CLIENT_BUNDLE}.map` : CLIENT_BUNDLE;
        if (!existsSync(file)) throw new HttpError(404, 'Client bundle not built; run npm run build');
        const body = readFileSync(file);
        const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        res.writeHead(200, {
          'content-type': url.pathname.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          ...(gzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
        });
        res.end(gzip ? gzipSync(body) : body);
        return;
      }
      // Icons are public, read-only and versioned: safe to cache forever when ?v= is given.
      const icon = /^\/assets\/icons\/([a-z0-9-]+)\.svg$/.exec(url.pathname);
      if (req.method === 'GET' && icon) {
        const file = `${ASSETS}icons/${icon[1]}.svg`;
        if (!existsSync(file)) throw new HttpError(404, 'Unknown icon');
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/gallery') {
        const file = `${ASSETS}gallery.html`;
        if (!existsSync(file)) throw new HttpError(404, 'Gallery not built; run npm run assets');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(readFileSync(file));
        return;
      }
      if (url.pathname === '/api/health') {
        return send(res, 200, { ok: true, repoRoot: ws.repoRoot });
      }
      const given = String(req.headers['x-tracenaut-token'] ?? '');
      if (!tokensEqual(given, token)) throw new HttpError(401, 'Missing or invalid TraceNaut token');

      if (req.method === 'GET' && url.pathname === '/api/status') {
        const status: StatusResult = {
          repoRoot: ws.repoRoot,
          services: ws.services,
          agents: hub.agentList(),
          editor: ws.editor,
          ai: { available: false },
          assetsVersion: assetsVersion(),
        };
        return send(res, 200, status);
      }
      if (req.method === 'GET' && url.pathname === '/api/stack') {
        // Re-scanned at most every 30 s; reading a large repository takes a moment.
        if (!stackCache || Date.now() - stackCache.at > 30_000) stackCache = { at: Date.now(), result: detectStack(ws) };
        return send(res, 200, stackCache.result);
      }
      if (req.method === 'POST' && url.pathname === '/api/journey') {
        const request = await readJson<InspectRequest>(req);
        const inspect = await analyzer.inspect(request);
        const result: JourneyResult = { inspect, flows: journeys.staticFlows(request, inspect) };
        return send(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/inspect') {
        return send(res, 200, await analyzer.inspect(await readJson<InspectRequest>(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/node') {
        return send(res, 200, await analyzer.node(required(url, 'id')));
      }
      if (req.method === 'GET' && url.pathname === '/api/callers') {
        return send(res, 200, analyzer.callers(required(url, 'id')));
      }
      if (req.method === 'POST' && url.pathname === '/api/trace/start') {
        return send(res, 200, await hub.start());
      }
      const finish = /^\/api\/trace\/([a-f0-9]+)\/finish$/.exec(url.pathname);
      if (req.method === 'POST' && finish) {
        const result = await hub.finish(finish[1], await readJson<FrontendTracePayload>(req));
        result.flow = journeys.observedFlow(result);
        return send(res, 200, result);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[tracenaut]', err);
      send(res, status, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = url.searchParams.get('token') ?? '';
    if (url.pathname !== '/agent' || !tokensEqual(given, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => hub.attach(client));
  });

  return { server, analyzer, hub };
}

function required(url: URL, name: string) {
  const v = url.searchParams.get(name);
  if (!v) throw new HttpError(400, `Missing query parameter: ${name}`);
  return v;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
