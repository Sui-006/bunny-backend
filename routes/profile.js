import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok, pick } from '../lib/rest.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try { ok(res, (await getState(req.user.id)).profile); } catch (e) { next(e); }
});

router.patch('/', async (req, res, next) => {
  try {
    const patch = pick(req.body, ['name', 'signature', 'avatar']);
    const doc = await getState(req.user.id);
    Object.assign(doc.profile, patch);
    await putState(req.user.id, doc);
    ok(res, doc.profile);
  } catch (e) { next(e); }
});

// POST /api/profile/avatar —— 头像（data URL）
router.post('/avatar', async (req, res, next) => {
  try {
    const avatar = String(req.body?.avatar || '');
    if (!avatar.startsWith('data:image/')) throw new HttpError(400, 'INVALID', 'avatar 必须是图片 data URL');
    const doc = await getState(req.user.id);
    doc.profile.avatar = avatar;
    await putState(req.user.id, doc);
    ok(res, doc.profile);
  } catch (e) { next(e); }
});

export default router;
