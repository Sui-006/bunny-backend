import crypto from 'node:crypto';
import { users, userTokens, getUserByEmail, createUser, findTokenUser } from './store.js';

// 单用户 Owner 认证：
//   - 个人私用，前端无登录 UI，默认「隐式 Owner」：请求不带 token 时自动解析唯一 owner。
//   - 仍提供完整 /api/auth/*（scrypt 口令 + 不透明 token），供程序化/多端使用。
//   - 所有业务表数据都落在 owner 的 user_state 文档里，天然单用户隔离。

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const TIMING_SAFE = (a, b) => {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${scrypt(pw, salt)}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    return TIMING_SAFE(hash, scrypt(pw, salt));
  } catch {
    return false;
  }
}

export async function issueToken(userId, ttlDays = 30) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null;
  await userTokens.insert({ user_id: userId, token_hash: sha256(raw), expires_at: expiresAt });
  return raw;
}

export async function revokeToken(raw) {
  await userTokens.removeWhere({ token_hash: sha256(raw) });
}

// 取唯一 owner：有则返回，无则创建（email 来自 OWNER_EMAIL 或 null）
export async function ensureOwner() {
  const rows = await users.all({ eq: {}, order: { col: 'created_at', asc: true }, limit: 1 });
  if (rows[0]) return rows[0];
  const email = (process.env.OWNER_EMAIL || '').trim() || null;
  return createUser({ email, passwordHash: null, state: {} });
}

// 中间件：解析当前用户（Bearer token → 用户；否则隐式 owner）
export function requireAuth(req, res, next) {
  (async () => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const rec = await findTokenUser(sha256(token));
      if (!rec || (rec.expires_at && new Date(rec.expires_at) < new Date())) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'token 无效或已过期' } });
      }
      const user = await users.one(rec.user_id);
      if (!user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '用户不存在' } });
      req.user = user;
      req.auth = { viaToken: true };
      return next();
    }
    if (process.env.ALLOW_IMPLICIT_OWNER === 'false') {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } });
    }
    req.user = await ensureOwner();
    req.auth = { viaToken: false };
    next();
  })().catch(next);
}
