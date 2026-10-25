import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every e2e run gets its own daemon session dir and database, on ports that do not
// clash with a developer's own TraceNaut / demo instances.
const home = process.env.TRACENAUT_E2E_HOME ?? mkdtempSync(path.join(tmpdir(), 'tracenaut-e2e-'));
process.env.TRACENAUT_E2E_HOME = home;
const env = { TRACENAUT_HOME: home, PORT: '3101', WEB_PORT: '5273', TASKBOARD_DB: path.join(home, 'taskboard.db') };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:5273', viewport: { width: 1400, height: 900 } },
  webServer: [
    { command: 'node packages/daemon/dist/cli.js start examples/taskboard --port 4499', url: 'http://127.0.0.1:4499/api/health', env, reuseExistingServer: false },
    { command: 'node --import @tracenaut/node-agent server/index.js', cwd: 'examples/taskboard', url: 'http://localhost:3101/api/health', env, reuseExistingServer: false },
    { command: 'npx vite --config web/vite.config.ts', cwd: 'examples/taskboard', url: 'http://localhost:5273', env, reuseExistingServer: false },
  ],
});
