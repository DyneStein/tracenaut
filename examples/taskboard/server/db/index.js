import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dbPath = process.env.TASKBOARD_DB ?? fileURLToPath(new URL('../../taskboard.db', import.meta.url));

export const db = new DatabaseSync(dbPath);

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seed();
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (existing.n > 0) return;
  const insertUser = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)');
  const { lastInsertRowid } = insertUser.run('ada@example.com', 'Ada Lovelace', hashPassword('analytical'));
  const insertTask = db.prepare('INSERT INTO tasks (user_id, title, done) VALUES (?, ?, ?)');
  insertTask.run(lastInsertRowid, 'Read the TraceNaut README', 1);
  insertTask.run(lastInsertRowid, 'Inspect the Sign in button', 0);
  insertTask.run(lastInsertRowid, 'Trace adding a task end to end', 0);
}
