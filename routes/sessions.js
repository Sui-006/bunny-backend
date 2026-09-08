import { Router } from 'express';
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listMessages,
  getSettings,
  DEFAULT_SETTINGS,
} from '../lib/db.js';

const router = Router();

// GET /api/sessions —— 会话列表
router.get('/', async (req, res, next) => {
  try {
    res.json({ sessions: await listSessions() });
  } catch (e) {
    next(e);
  }
});

// POST /api/sessions —— 新建会话
router.post('/', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim() || '新的对话';
    const session = await createSession(name);
    res.status(201).json({ session });
  } catch (e) {
    next(e);
  }
});

// GET /api/sessions/:sessionId —— 会话详情（含设置与最近消息）
router.get('/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });

    const [settings, messages] = await Promise.all([
      getSettings(sessionId),
      listMessages(sessionId, { limit: 50 }),
    ]);
    res.json({
      session,
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
      messages,
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/sessions/:sessionId —— 重命名 / 置顶（按需传 name、pinned）
router.patch('/:sessionId', async (req, res, next) => {
  try {
    const { name, pinned } = req.body || {};
    const patch = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'name 不能为空' });
      patch.name = trimmed;
    }
    if (pinned !== undefined) patch.pinned = Boolean(pinned);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '没有可更新的字段' });
    }
    const session = await updateSession(req.params.sessionId, patch);
    res.json({ session });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/sessions/:sessionId —— 删除会话
router.delete('/:sessionId', async (req, res, next) => {
  try {
    await deleteSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
