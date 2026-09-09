import { Router } from 'express';
import { requireAuth, hashPassword, verifyPassword, issueToken, revokeToken, ensureOwner } from '../lib/auth.js';
import { users, getUserByEmail } from '../lib/store.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

// POST /api/auth/register —— 单用户：仅允许注册为唯一 owner
router.post('/register', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'INVALID', '邮箱格式不正确');
    if (password.length < 6) throw new HttpError(400, 'INVALID', '密码至少 6 位');

    const existing = await getUserByEmail(email);
    if (existing) throw new HttpError(409, 'CONFLICT', '该邮箱已注册');

    const owner = await ensureOwner();
    if (owner.email && owner.email !== email) {
      throw new HttpError(409, 'CONFLICT', '该应用为单用户，仅允许一个账号');
    }
    await users.update(owner.id, { email, password_hash: hashPassword(password) });
    const token = await issueToken(owner.id);
    ok(res, { user: { id: owner.id, email }, token }, 201);
  } catch (e) { next(e); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'UNAUTHORIZED', '邮箱或密码错误');
    }
    const token = await issueToken(user.id);
    ok(res, { user: { id: user.id, email: user.email }, token });
  } catch (e) { next(e); }
});

// POST /api/auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) await revokeToken(token);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  ok(res, { user: { id: req.user.id, email: req.user.email || null } });
});

export default router;
