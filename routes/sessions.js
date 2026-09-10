import { Router } from 'express';
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listMessages,
  createMessage,
  getSettings,
  DEFAULT_SETTINGS,
} from '../lib/db.js';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';

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

// POST /api/sessions/:sessionId/retitle —— 由 AI 根据最近对话重新生成标题（需求 1）
router.post('/:sessionId/retitle', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const messages = await listMessages(sessionId, { limit: 20, visibleOnly: true });
    const text = messages.slice(0, 12).map((m) => (m.role === 'user' ? '我：' : 'AI：') + (m.content || '')).join('\n').trim();
    if (!text) return res.status(400).json({ error: '会话没有消息，无法生成标题' });
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();
    const reply = await chat({
      model,
      system: '你是会话标题生成器。根据对话内容生成一个简洁、准确的中文标题。',
      temperature: 0.3,
      maxTokens: 40,
      messages: [{ role: 'user', content: '为下面这段对话生成一个不超过 12 个字的标题，只输出标题本身，不要引号、不要解释、不要换行：\n' + text.slice(0, 3000) }],
    });
    const name = (reply.content || '').replace(/[\r\n"「」『』]/g, '').trim().slice(0, 20) || '新的对话';
    const session = await updateSession(sessionId, { name });
    res.json({ session });
  } catch (e) {
    next(e);
  }
});

// POST /api/sessions/:sessionId/duplicate —— 复制会话及其消息（需求 1）
router.post('/:sessionId/duplicate', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const src = await getSession(sessionId);
    if (!src) return res.status(404).json({ error: '会话不存在' });
    const copy = await createSession((src.name || '新的对话') + ' 副本');
    const msgs = await listMessages(sessionId, { limit: 500, visibleOnly: false });
    for (const m of msgs) {
      await createMessage(copy.id, {
        role: m.role,
        content: m.content,
        reasoningContent: m.reasoning_content,
        visible: m.visible !== false,
        metadata: m.metadata,
      });
    }
    res.status(201).json({ session: copy });
  } catch (e) {
    next(e);
  }
});

export default router;
