import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Session {
  port: number;
  token: string;
  repoRoot: string;
  assetsVersion?: string;
}

export const sessionFile = () => path.join(process.env.TRACENAUT_HOME ?? path.join(homedir(), '.tracenaut'), 'daemon.json');

export function readSession(): Session | undefined {
  try {
    return JSON.parse(readFileSync(sessionFile(), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Nearest folder with tracenaut.json, else .git, from `start` upwards. */
export function findRepoRoot(start: string, exists: (p: string) => boolean) {
  for (const marker of ['tracenaut.json', '.git']) {
    for (let dir = start; ; ) {
      if (exists(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return start;
}
