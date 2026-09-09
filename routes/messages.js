import { Router } from 'express';
import {
  getSettings, getAppSettings, DEFAULT_SETTINGS,
  createMessage, listMessages, deleteMessage, getLastAssistantMessage, touchSession,
} from '../lib/db.js';
import { prepareContext } from '../lib/context.js';
import { chat, chatStream } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { sendBark } from '../lib/bark.js';
import { composeNotification, barkLevelFor } from '../lib/notify.js';
import { McpSession, parseMcpServers } from '../lib/mcp.js';

const router = Router();

// 组装会话环境：设置 + 全局配置 + MCP 插件（若配置）
async function buildChatEnv(sessionId) {
  const settings = { ...DEFAULT_SETTINGS, ...((await getSettings(sessionId)) || {}) };
  const app = await getAppSettings();
  settings.personal_signature = app?.personal_signature;

  let mcp = null;
  let tools = [];
  const servers = parseMcpServers(app?.mcp_servers);
  if (servers.length) {
    mcp = new McpSession(servers);
    await mcp.start();
    tools = mcp.tools;
  }
  return { settings, app, mcp, tools };
}

// 回复通知：标题/正文由 AI 生成（普通通知，绝不 critical/call）
async function notifyReply(barkUrl, model, content) {
  try {
    const composed = await composeNotification({
      model,
      context: `AI 刚回复了用户一条消息。请生成一条简短的手机通知（标题+正文），概括或自然引出这条回复。type=NORMAL。回复内容：${content}`,
    });
    const lvl = composed && composed.type === 'ALARM' ? 'normal' : barkLevelFor(composed?.type);
    await sendBark({
      barkUrl,
      title: composed?.title || '新的回复',
      body: composed?.body || content,
      level: lvl,
    });
  } catch (e) {
    // 通知失败不阻断主流程
    console.warn('[messages] 回复通知发送异常：', e.message);
  }
}

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

// POST /api/sessions/:sessionId/messages —— 核心对话流程（支持流式 + MCP 工具）
router.post('/:sessionId/messages', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const content = (req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });

    const { settings, app, mcp, tools } = await buildChatEnv(sessionId);
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();

    const userMessage = await createMessage(sessionId, { role: 'user', content });
    const { system, messages, compressed } = await prepareContext({ sessionId, settings, model });

    const stream = settings.stream && tools.length === 0;
    const barkUrl = app?.bark_url || config.barkUrl;
    const notify = app?.reply_notify_enabled && barkUrl && req.body?.notify;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let full = '';
      let result;
      try {
        result = await chatStream({
          model, system, messages,
          temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
          onDelta: (d) => { full += d; send({ delta: d }); },
        });
        full = result.content || full;
      } catch (e) {
        send({ error: e.message });
        send({ done: true });
        res.end();
        await mcp?.close();
        return;
      }

      const assistantMessage = await createMessage(sessionId, {
        role: 'assistant', content: full, reasoningContent: result.reasoningContent,
        metadata: { usage: result.usage, model },
      });
      await touchSession(sessionId);
      if (notify) await notifyReply(barkUrl, model, full);

      send({ done: true, assistantMessage, compressed });
      res.end();
      await mcp?.close();
      return;
    }

    // 非流式（含 MCP 工具循环）
    const reply = await chat({
      model, system, messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? (name, args) => mcp.callTool(name, args) : null,
    });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model },
    });
    await touchSession(sessionId);
    if (notify) await notifyReply(barkUrl, model, reply.content);

    await mcp?.close();
    res.status(201).json({ userMessage, assistantMessage, compressed });
  } catch (e) {
    next(e);
  }
});

// POST /api/sessions/:sessionId/regenerate —— 重新生成最后一条 AI 回复
router.post('/:sessionId/regenerate', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { settings, app, mcp, tools } = await buildChatEnv(sessionId);
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();

    const last = await getLastAssistantMessage(sessionId);
    if (last) await deleteMessage(last.id);

    const { system, messages, compressed } = await prepareContext({ sessionId, settings, model });
    const reply = await chat({
      model, system, messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? (name, args) => mcp.callTool(name, args) : null,
    });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model },
    });
    await touchSession(sessionId);
    await mcp?.close();

    res.status(201).json({ assistantMessage, compressed });
  } catch (e) {
    next(e);
  }
});

export default router;
