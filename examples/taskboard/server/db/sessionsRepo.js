import { db } from './index.js';

export function insertSession(token, userId) {
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
}

export function findSession(token) {
  return db.prepare('SELECT token, user_id FROM sessions WHERE token = ?').get(token);
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
