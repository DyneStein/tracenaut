import { db } from './index.js';

export function findUserByEmail(email) {
  return db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
}

export function findUserById(id) {
  return db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(id);
}
