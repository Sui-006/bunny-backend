import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok, pick, requireFields } from '../lib/rest.js';

const router = Router();
const CONV_FIELDS = ['name', 'avatar', 'kind', 'unread', 'last', 'time'];

router.get('/', async (req, res, next) => {
  try { ok(res, await (await getState(req.user.id)).conversations); } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const c = doc.conversations.find((x) => x.id === req.params.id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', '会话不存在');
    ok(res, c);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const conv = {
      id: randomUUID(), name: '', avatar: '💬', kind: 'friend', unread: 0, last: '', time: Date.now(), messages: [],
      ...pick(req.body, CONV_FIELDS),
    };
    doc.conversations.push(conv);
    await putState(req.user.id, doc);
    ok(res, conv, 201);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = pick(req.body, CONV_FIELDS);
    const doc = await getState(req.user.id);
    const c = doc.conversations.find((x) => x.id === req.params.id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', '会话不存在');
    Object.assign(c, patch);
    await putState(req.user.id, doc);
    ok(res, c);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.conversations = doc.conversations.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/conversations/:id/messages —— 发消息 {role:'in'|'out', content}
router.post('/:id/messages', async (req, res, next) => {
  try {
    requireFields(req.body, ['content']);
    const role = req.body.role === 'out' ? 'out' : 'in';
    const doc = await getState(req.user.id);
    const c = doc.conversations.find((x) => x.id === req.params.id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', '会话不存在');
    const msg = { role, content: String(req.body.content), time: Date.now() };
    c.messages = c.messages || [];
    c.messages.push(msg);
    c.last = String(req.body.content);
    c.time = msg.time;
    if (role === 'in') c.unread = (c.unread || 0) + 1;
    await putState(req.user.id, doc);
    ok(res, msg, 201);
  } catch (e) { next(e); }
});

export default router;
