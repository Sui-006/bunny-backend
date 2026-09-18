import { Router } from 'express';
import {
  getSettings, getAppSettings, DEFAULT_SETTINGS, effectiveAppSettings,
  createMessage, listMessages, deleteMessage, getLastAssistantMessage, touchSession,
  updateMessage, markMessagesAfterInvisible,
} from '../lib/db.js';
import { chat, chatStream, normalizeProviderUsage, providerForModel } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { sendNotification, resolveBarkUrl } from '../lib/notification-engine.js';
import { composeNotification, barkLevelFor } from '../lib/notify.js';
import { McpSession, parseMcpServers } from '../lib/mcp.js';
import { ensureOwner } from '../lib/auth.js';
import { getState } from '../lib/domain.js';
import { detectDomains, TOOL_DOMAIN_SET } from '../lib/aiContext.js';
import { buildDomainTools, AI_SELF_TOOL_NAMES, AI_CACHE_TOOL_NAMES, AI_NOTIFY_TOOL_NAMES } from '../lib/tools.js';
import { buildAIContext } from '../lib/context-builder.js';
import { maybeSummarize, invalidateSummary } from '../services/conversation-summary.js';
import { attachments as attachmentsTable } from '../lib/store.js';
import { prepareAttachmentsForAI, attachmentRow } from '../lib/attachments.js';

const router = Router();

// provider usage → 统一可观测字段（仅计数，不含任何内容）合并进 contextStats 存储
function withProviderUsage(stats, usage, model) {
  return { ...stats, ...normalizeProviderUsage(usage, providerForModel(model), model) };
}

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

// 组装会话环境 + 领域工具（财务/经期/病历按问题相关性注入）；统一上下文由 buildAIContext 组装
async function buildAssistEnv(sessionId, content, model = config.defaultModel) {
  const { settings, app, mcp, tools: mcpTools } = await buildChatEnv(sessionId);
  const userId = (await ensureOwner()).id;
  const doc = await getState(userId);
  const domains = detectDomains(content);
  const domain = buildDomainTools(userId, model, { sessionId });
  // 只有「可编辑领域」才注入编辑工具；只读域（life/journal/statistics/conversation）仅注入读块。
  const useDomain = domains.some((d) => TOOL_DOMAIN_SET.has(d));
  // AI 自我工具（读时间 + AI 动态 CRUD）+ 对话缓存工具不依赖领域关键词，始终注入；命中领域时随完整领域工具集一起注入。
  const selfSet = new Set([...AI_SELF_TOOL_NAMES, ...AI_CACHE_TOOL_NAMES, ...AI_NOTIFY_TOOL_NAMES]);
  const selfTools = domain.tools.filter((t) => selfSet.has(t.name));
  const tools = [...mcpTools, ...(useDomain ? domain.tools : selfTools)];
  const callTool = async (name, args) => {
    if (domain.names.includes(name)) return domain.callTool(name, args);
    if (mcp) return mcp.callTool(name, args);
    throw new Error('未知工具: ' + name);
  };
  return { settings, app, mcp, tools, callTool, doc, userId };
}

// 解析附件：按 id 读取 + 所有权校验（用户 A 不能引用用户 B 的附件），最多 10 个。
async function resolveAttachments(userId, ids) {
  const list = Array.isArray(ids) ? ids.slice(0, 10).map((x) => String(x)) : [];
  const rows = [];
  for (const id of list) {
    if (!id) continue;
    const rec = await attachmentsTable.one(id);
    if (rec && rec.user_id === userId) rows.push(rec);
  }
  return rows;
}

// 把附件注入到最后一条用户消息：文本文件正文拼进 content，图片走 images（多模态）。
// 已存在的 metadata.attachments 只做持久化；AI 看到的内容在这里即时生成，不污染消息原文。
async function augmentLastUserMessage(messages, rows) {
  if (!rows.length || !messages.length) return messages;
  const { textBlocks, imageDataUrls, notes } = await prepareAttachmentsForAI(rows);
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    let c = last.content || '';
    if (textBlocks.length) c += '\n\n' + textBlocks.join('\n\n');
    if (notes.length) c += '\n\n' + notes.join('\n');
    last.content = c;
    if (imageDataUrls.length) last.images = imageDataUrls;
  }
  return messages;
}

// 回复通知：标题/正文由 AI 生成（普通通知，绝不 critical/call），经统一 NotificationEngine 发送。
async function notifyReply(model, content) {
  try {
    const barkUrl = await resolveBarkUrl();
    if (!barkUrl) return; // 未配置 Bark：静默跳过（不算错误，也不假装成功）
    const composed = await composeNotification({
      model,
      context: `AI 刚回复了用户一条消息。请生成一条简短的手机通知（标题+正文），概括或自然引出这条回复。type=NORMAL。回复内容：${content}`,
    });
    const lvl = composed && composed.type === 'ALARM' ? 'normal' : barkLevelFor(composed?.type);
    await sendNotification({
      barkUrl,
      title: composed?.title || '新的回复',
      body: composed?.body || content,
      level: lvl,
      source: 'reply',
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
    const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.slice(0, 10).map((x) => String(x)) : [];
    if (!content && attachmentIds.length === 0) return res.status(400).json({ error: 'content 不能为空' });

    // 引用 AI 动态（需求 33）：{ id, type:'ai_dynamic', content, createdAt }，仅作为上下文注入，不写入长期记忆
    const qd = req.body?.quotedDynamic;
    const quotedDynamic = (qd && qd.content) ? { id: qd.id, type: 'ai_dynamic', content: String(qd.content), createdAt: qd.createdAt } : null;

    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();
    const { settings, app, mcp, tools, callTool, doc, userId } = await buildAssistEnv(sessionId, content, model);

    // 附件：解析 + 所有权校验 + 持久化到消息 metadata.attachments（独立字段，不进 content）
    const attachmentRows = await resolveAttachments(userId, attachmentIds);
    const attachmentMeta = attachmentRows.map((r) => attachmentRow(r, ''));
    const metadata = {};
    if (quotedDynamic) metadata.quotedDynamic = quotedDynamic;
    if (attachmentMeta.length) metadata.attachments = attachmentMeta;

    const userMessage = await createMessage(sessionId, { role: 'user', content, ...(Object.keys(metadata).length ? { metadata } : {}) });
    const built = await buildAIContext({ sessionId, doc, settings, content, model, tools, callTool, quotedDynamic });
    await augmentLastUserMessage(built.messages, attachmentRows);

    const stream = settings.stream && tools.length === 0;
    const notify = effectiveAppSettings(app).reply_notify_enabled && req.body?.notify;

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
          model, system: built.system, systemBlocks: built.systemBlocks, messages: built.messages,
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
        metadata: { usage: result.usage, model, contextStats: withProviderUsage(built.stats, result.usage, model) },
      });
      await touchSession(sessionId);
      maybeSummarize(sessionId, { userId, settings, model }).catch(() => {});
      if (notify) await notifyReply(model, full);

      send({ done: true, userMessage, assistantMessage, compressed: false });
      res.end();
      await mcp?.close();
      return;
    }

    // 工具循环路径（MCP + 领域工具）：SSE 流式下发 tool 工作状态 + 最终 assistant 消息。
    // 前端据此在 AI 调用工具的当下就显示「小澄正在…」，而不是等整段跑完才一次性回传，避免 Chat 空白等待。
    if (tools.length > 0) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      let reply;
      try {
        reply = await chat({
          model, system: built.system, systemBlocks: built.systemBlocks, messages: built.messages,
          temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
          tools, callTool,
          onToolEvent: (ev) => send({ toolEvent: ev }),
        });
      } catch (e) {
        send({ error: e.message });
        send({ done: true });
        res.end();
        await mcp?.close();
        return;
      }

      const assistantMessage = await createMessage(sessionId, {
        role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
        metadata: { usage: reply.usage, model, contextStats: withProviderUsage(built.stats, reply.usage, model) },
      });
      await touchSession(sessionId);
      maybeSummarize(sessionId, { userId, settings, model }).catch(() => {});
      if (notify) await notifyReply(model, reply.content);

      send({ done: true, userMessage, assistantMessage, compressed: false });
      res.end();
      await mcp?.close();
      return;
    }

    // 无工具的非流式（普通 JSON 回复；toolEvents 恒为空）
    const reply = await chat({
      model, system: built.system, systemBlocks: built.systemBlocks, messages: built.messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
    });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model, contextStats: withProviderUsage(built.stats, reply.usage, model) },
    });
    await touchSession(sessionId);
    maybeSummarize(sessionId, { userId, settings, model }).catch(() => {});
    if (notify) await notifyReply(model, reply.content);

    await mcp?.close();
    res.status(201).json({ userMessage, assistantMessage, compressed: false, toolEvents: reply.toolEvents || [] });
  } catch (e) {
    next(e);
  }
});

// POST /api/sessions/:sessionId/messages/:messageId/edit —— 编辑用户消息 + 从这里重新生成
// 编辑用户消息内容，软删除其后的消息，重新生成 AI 回复（不破坏整个 conversation 历史）。
router.post('/:sessionId/messages/:messageId/edit', async (req, res, next) => {
  try {
    const { sessionId, messageId } = req.params;
    const content = (req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });

    // 校验目标消息存在且是 user 角色
    const allMsgs = await listMessages(sessionId, { limit: 500, visibleOnly: false });
    const target = allMsgs.find((m) => m.id === messageId);
    if (!target) return res.status(404).json({ error: '消息不存在' });
    if (target.role !== 'user') return res.status(400).json({ error: '只能编辑用户消息' });

    await updateMessage(messageId, { content });

    // 软删除该用户消息之后的所有消息（含旧 AI 回复），让 AI 从这里重新作答
    await markMessagesAfterInvisible(sessionId, messageId);
    // 历史被改动 → 失效该会话摘要（下次 rebuild），不就地删旧摘要
    await invalidateSummary(sessionId).catch(() => {});

    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();
    const { settings, app, mcp, tools, callTool, doc, userId } = await buildAssistEnv(sessionId, content, model);
    const built = await buildAIContext({ sessionId, doc, settings, content, model, tools, callTool });

    const reply = await chat({
      model, system: built.system, systemBlocks: built.systemBlocks, messages: built.messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? callTool : null,
    });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model, contextStats: withProviderUsage(built.stats, reply.usage, model) },
    });
    await touchSession(sessionId);
    await mcp?.close();

    // 重新拉取可见消息列表（编辑后的一致视图），供前端刷新
    const visible = (await listMessages(sessionId, { limit: 500, visibleOnly: true })).filter((m) => m.visible !== false);
    res.status(201).json({ assistantMessage, messages: visible, compressed: false });
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

    const model = (req.body?.model || config.defaultModel || 'deepseek-chat').trim();
    const { settings, app, mcp, tools, callTool, doc, userId } = await buildAssistEnv(sessionId, content, model);

    const last = await getLastAssistantMessage(sessionId);
    if (last) await deleteMessage(last.id);

    const built = await buildAIContext({ sessionId, doc, settings, content, model, tools, callTool });
    const reply = await chat({
      model, system: built.system, systemBlocks: built.systemBlocks, messages: built.messages,
      temperature: settings.temperature, maxTokens: settings.max_reply_tokens,
      tools,
      callTool: tools.length ? callTool : null,
    });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant', content: reply.content, reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model, contextStats: withProviderUsage(built.stats, reply.usage, model) },
    });
    await touchSession(sessionId);
    await mcp?.close();

    res.status(201).json({ assistantMessage, compressed: false });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/sessions/:sessionId/messages/:messageId —— 删除单条消息（需求 13）
router.delete('/:sessionId/messages/:messageId', async (req, res, next) => {
  try {
    const { sessionId, messageId } = req.params;
    const allMsgs = await listMessages(sessionId, { limit: 500, visibleOnly: false });
    const target = allMsgs.find((m) => m.id === messageId);
    if (!target) return res.status(404).json({ error: '消息不存在' });
    await deleteMessage(messageId);
    await invalidateSummary(sessionId).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
