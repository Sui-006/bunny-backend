import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let list = doc.notifications;
    if (req.query.unread !== undefined) list = list.filter((n) => Boolean(n.read) !== (req.query.unread === 'true' || req.query.unread === '1'));
    ok(res, list);
  } catch (e) { next(e); }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const n = doc.notifications.find((x) => x.id === req.params.id);
    if (!n) throw new HttpError(404, 'NOT_FOUND', '通知不存在');
    n.read = req.body?.read !== undefined ? Boolean(req.body.read) : true;
    await putState(req.user.id, doc);
    ok(res, n);
  } catch (e) { next(e); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    for (const n of doc.notifications) n.read = true;
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
