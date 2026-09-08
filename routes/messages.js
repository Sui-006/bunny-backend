import { Router } from 'express';
import { getSettings, getAppSettings, DEFAULT_SETTINGS, createMessage, listMessages } from '../lib/db.js';
import { prepareContext } from '../lib/context.js';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { sendBarkNotification } from '../lib/bark.js';

const router = Router();

// GET /api/sessions/:sessionId/messages —— 消息列表（?limit=）
router.get('/:sessionId/messages', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const messages = await listMessages(req.params.sessionId, { limit, visibleOnly: false });
    res.json({ messages });
  } catch (e) {
    next(e);
  }
});

// POST /api/sessions/:sessionId/messages —— 核心对话流程
// body: { content: string, model?: string }
// 流程：落库用户消息 → 组装上下文（含记忆摘要，必要时压缩）→ 调用 AI → 落库回复
router.post('/:sessionId/messages', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const content = (req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });

    const settings = { ...DEFAULT_SETTINGS, ...((await getSettings(sessionId)) || {}) };
    const app = await getAppSettings();
    settings.personal_signature = app?.personal_signature;
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();

    // 1. 落库用户消息
    const userMessage = await createMessage(sessionId, { role: 'user', content });

    // 2. 组装上下文 + 记忆压缩
    const { system, messages, compressed } = await prepareContext({ sessionId, settings, model });

    // 3. 调用 AI
    const reply = await chat({
      model,
      system,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.max_reply_tokens,
    });

    // 4. 落库 AI 回复（含推理内容、usage）
    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant',
      content: reply.content,
      reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model },
    });

    // 普通回复也推 Bark（仅当用户不在该页面时，由前端 notify 标记）
    if (app?.reply_notify_enabled && app?.bark_url && req.body?.notify) {
      await sendBarkNotification(app.bark_url, '回复 💬', reply.content);
    }

    res.status(201).json({ userMessage, assistantMessage, compressed });
  } catch (e) {
    next(e);
  }
});

export default router;
