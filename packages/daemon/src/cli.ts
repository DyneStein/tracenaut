import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadWorkspace } from './workspace.js';
import { assetsVersion, createDaemon } from './server.js';
import { clearSession, readSession, writeSession, SESSION_FILE } from './session.js';

const DEFAULT_PORT = 4417;

function usage() {
  console.log(`TraceNaut — start from the running app, follow the code behind it.

Usage:
  tracenaut start [repo] [--port ${DEFAULT_PORT}] [--new-token]
                                           Analyse a repository and serve the inspector.
                                           The access token is kept across restarts for the
                                           same repository (open pages keep working);
                                           --new-token replaces it.
  tracenaut status                         Show the running daemon

TraceNaut reads your source code. It never starts or executes your application;
you run it yourself, as usual.`);
}

async function start(args: string[]) {
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : DEFAULT_PORT;
  const repoArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') ?? '.';
  const ws = loadWorkspace(path.resolve(repoArg));
  // Reuse the previous token for the same repository, so pages and bundler-injected clients
  // keep working across daemon restarts. It lives only in the owner-only session file.
  const previous = readSession();
  const token = !args.includes('--new-token') && previous?.repoRoot === ws.repoRoot && /^[a-f0-9]{48}$/.test(previous.token) ? previous.token : randomBytes(24).toString('hex');
  const { server, analyzer } = createDaemon(ws, token);

  server.listen(port, '127.0.0.1', () => {
    writeSession({ port, token, pid: process.pid, repoRoot: ws.repoRoot, startedAt: new Date().toISOString(), assetsVersion: assetsVersion() });
    console.log(`\nTraceNaut daemon (local only) → http://127.0.0.1:${port}`);
    console.log(`Repository: ${ws.repoRoot}`);
    console.log(`Services (${ws.origin}):`);
    for (const s of ws.services) console.log(`  • ${s.name.padEnd(10)} ${s.kind.padEnd(8)} ${s.root || '.'}/`);
    console.log(`\nNext:`);
    console.log(`  Browser  add tracenaut() to your Vite plugins, open the dev server, Alt+right-click an element.`);
    console.log(`  Node     run your server with: node --import @tracenaut/node-agent <entry>  (optional, enables backend tracing)`);
    console.log(`\nSession file: ${SESSION_FILE} (port + access token, readable only by you)\n`);
    // Warm the TypeScript programs so the first inspection is fast.
    setTimeout(() => {
      for (const s of ws.services) {
        try {
          analyzer.project(s.name).program();
        } catch (err) {
          console.warn(`[tracenaut] could not analyse ${s.name}: ${(err as Error).message}`);
        }
      }
      console.log('[tracenaut] analysis ready');
    }, 10);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use (is another TraceNaut daemon running?)` : err.message);
    process.exit(1);
  });
  const stop = () => {
    clearSession(process.pid);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'start') await start(rest);
else if (command === 'status') {
  const s = readSession();
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  console.log(s?.pid && alive(s.pid) ? `Running: pid ${s.pid}, http://127.0.0.1:${s.port}, repo ${s.repoRoot}` : 'No TraceNaut daemon is running.');
} else usage();
