import { Router } from 'express';
import { verifyCredentials, startSession, endSession, AuthError } from '../services/authService.js';
import { requireAuth, readSessionCookie } from '../middleware/requireAuth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  try {
    const user = verifyCredentials(req.body.email, req.body.password);
    const token = startSession(user.id);
    res.cookie('tb_session', token, { httpOnly: true, sameSite: 'lax' });
    res.json({ user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    throw err;
  }
});

authRouter.post('/logout', (req, res) => {
  endSession(readSessionCookie(req));
  res.clearCookie('tb_session');
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
