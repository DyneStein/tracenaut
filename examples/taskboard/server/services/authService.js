import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { findUserByEmail, findUserById } from '../db/usersRepo.js';
import { insertSession, findSession, deleteSession } from '../db/sessionsRepo.js';

export class AuthError extends Error {}

export function verifyCredentials(email, password) {
  const user = findUserByEmail(normalizeEmail(email));
  if (!user || !passwordMatches(password, user.password_hash)) {
    throw new AuthError('Invalid email or password');
  }
  return { id: user.id, email: user.email, name: user.name };
}

export function startSession(userId) {
  const token = randomBytes(24).toString('hex');
  insertSession(token, userId);
  return token;
}

export function userForSession(token) {
  if (!token) return null;
  const session = findSession(token);
  return session ? findUserById(session.user_id) : null;
}

export function endSession(token) {
  if (token) deleteSession(token);
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function passwordMatches(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(String(password ?? ''), salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
