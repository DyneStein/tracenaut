import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The daemon advertises itself through a user-private file so the Vite plugin and
 * the Node agent can find it (port + token) without the user copying secrets around.
 */
export interface SessionInfo {
  port: number;
  token: string;
  pid: number;
  repoRoot: string;
  startedAt: string;
  assetsVersion?: string;
}

export const SESSION_DIR = process.env.TRACENAUT_HOME ?? path.join(homedir(), '.tracenaut');
export const SESSION_FILE = path.join(SESSION_DIR, 'daemon.json');

export function writeSession(info: SessionInfo) {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

export function readSession(): SessionInfo | undefined {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return undefined;
  }
}

export function clearSession(pid: number) {
  const current = readSession();
  if (current?.pid === pid) rmSync(SESSION_FILE, { force: true });
}
