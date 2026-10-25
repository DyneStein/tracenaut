import { userForSession } from '../services/authService.js';

export function readSessionCookie(req) {
  const header = req.headers.cookie ?? '';
  const match = header.match(/(?:^|;\s*)tb_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function requireAuth(req, res, next) {
  const user = userForSession(readSessionCookie(req));
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = user;
  next();
}
