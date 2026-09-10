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
import { ensureOwner } from '../lib/auth.js';
import { getState } from '../lib/domain.js';
import { buildContextSnippet, detectDomains } from '../lib/aiContext.js';
import { buildDomainTools } from '../lib/tools.js';

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

// 组装会话环境 + 领域上下文 + 领域工具（财务/经期/病历按问题相关性注入）
async function buildAssistEnv(sessionId, content) {
  const { settings, app, mcp, tools: mcpTools } = await buildChatEnv(sessionId);
  const userId = (await ensureOwner()).id;
  const doc = await getState(userId);
  const contextSnippet = await buildContextSnippet(doc, content);
  const domains = detectDomains(content);
  const domain = buildDomainTools(userId);
  const useDomain = domains.length > 0;
  const tools = [...mcpTools, ...(useDomain ? domain.tools : [])];
  const callTool = async (name, args) => {
    if (useDomain && domain.names.includes(name)) return domain.callTool(name, args);
    if (mcp) return mcp.callTool(name, args);
    throw new Error('未知工具: ' + name);
  };
  return { settings, app, mcp, tools, callTool, contextSnippet };
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

    // 引用 AI 动态（需求 33）：{ id, type:'ai_dynamic', content, createdAt }，仅作为上下文注入，不写入长期记忆
    const qd = req.body?.quotedDynamic;
    const quotedDynamic = (qd && qd.content) ? { id: qd.id, type: 'ai_dynamic', content: String(qd.content), createdAt: qd.createdAt } : null;

    const { settings, app, mcp, tools, callTool, contextSnippet } = await buildAssistEnv(sessionId, content);
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();

    const userMessage = await createMessage(sessionId, { role: 'user', content, ...(quotedDynamic ? { metadata: { quotedDynamic } } : {}) });
    const { system, messages, compressed } = await prepareContext({ sessionId, settings, model });
    const quoteNote = quotedDynamic ? '\n\n[用户引用了以下 AI 动态来发起对话，请结合这条动态内容理解用户意图]\n引用动态内容：' + quotedDynamic.content : '';
    const systemWithCtx = [system, contextSnippet, quoteNote].filter(Boolean).join('\n\n');

    const stream = settings.stream && tools.length === 0;
    const barkUrl = config.barkUrl || app?.bark_url;
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
          model, system: systemWithCtx, messages,
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

    // 非流式（含 MCP + 领域工具循环）
    const reply = await chat({
      model, system: systemWithCtx, messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? callTool : null,
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
    const allMsgs = await listMessages(sessionId, { limit: 50, visibleOnly: true });
    const lastUser = [...allMsgs].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content || '';

    const { settings, app, mcp, tools, callTool, contextSnippet } = await buildAssistEnv(sessionId, content);
    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();

    const last = await getLastAssistantMessage(sessionId);
    if (last) await deleteMessage(last.id);

    const { system, messages, compressed } = await prepareContext({ sessionId, settings, model });
    const systemWithCtx = [system, contextSnippet].filter(Boolean).join('\n\n');
    const reply = await chat({
      model, system: systemWithCtx, messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? callTool : null,
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
