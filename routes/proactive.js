import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  getAppSettings,
  saveAppSettings,
  getSettings,
  getSession,
  DEFAULT_SETTINGS,
  getLatestActiveSessionId,
  getLastMessageAt,
  createMessage,
  touchSession,
  effectiveAppSettings,
} from '../lib/db.js';
import { chat, normalizeProviderUsage, providerForModel, resolveAssistantModel } from '../lib/ai.js';
import { sendNotification } from '../lib/notification-engine.js';
import { getState, withDoc } from '../lib/domain.js';
import { ensureOwner } from '../lib/auth.js';
import { buildAIContext } from '../lib/context-builder.js';

const router = Router();

// Asia/Shanghai（UTC+8，无夏令时）
function shanghaiNow(base = new Date()) {
  const utc = base.getTime() + base.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

function shanghaiDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'HH:MM' → 当天分钟数；非法返回 null
function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const pad2 = (n) => String(n).padStart(2, '0');

// 纯决策函数（可测试）：根据有效设置 + 当前上海时间 + 最后消息时间，决定此刻该发哪条主动消息。
// 返回 { reason, instruction } 或 null（不该发）。
//   reason: morning | noon | night | idle
export function decideProactive(app, shNow, now, lastMessageAt) {
  const today = shanghaiDate(shNow);
  const nowMin = shNow.getHours() * 60 + shNow.getMinutes();

  // A. 早安问候（当天没发过，且落在 [时间, +90min) 窗口内，容忍 cron 延迟）
  const morningTime = timeToMinutes(app.proactive_morning_time || '08:00');
  if (app.proactive_morning_enabled && morningTime !== null && app.proactive_last_morning_date !== today) {
    if (nowMin >= morningTime && nowMin < morningTime + 90) {
      return {
        reason: 'morning',
        instruction: `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条早安问候，自然亲切，简短一点，体现你对 ta 的了解。`,
      };
    }
  }

  // B. 午安问候
  const noonTime = timeToMinutes(app.proactive_noon_time || '12:00');
  if (app.proactive_noon_enabled && noonTime !== null && app.proactive_last_noon_date !== today) {
    if (nowMin >= noonTime && nowMin < noonTime + 90) {
      return {
        reason: 'noon',
        instruction: `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条午安问候，自然亲切，简短一点，体现你对 ta 的了解。`,
      };
    }
  }

  // C. 晚安问候
  const nightTime = timeToMinutes(app.proactive_night_time || '22:00');
  if (app.proactive_night_enabled && nightTime !== null && app.proactive_last_night_date !== today) {
    if (nowMin >= nightTime && nowMin < nightTime + 90) {
      return {
        reason: 'night',
        instruction: `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条晚安问候，温柔一点，简短，体现你对 ta 的了解。`,
      };
    }
  }

  // D. 空闲提醒（N 小时没消息）
  if (app.proactive_idle_enabled && app.proactive_idle_hours) {
    const idleHours = Number(app.proactive_idle_hours);
    if (idleHours > 0 && lastMessageAt) {
      const idleMin = (now.getTime() - new Date(lastMessageAt).getTime()) / 60000;
      if (idleMin >= idleHours * 60) {
        const hrs = Math.max(1, Math.floor(idleMin / 60));
        return {
          reason: 'idle',
          instruction: `用户已经 ${hrs} 小时没有发消息了，请主动发一条简短自然的关心/想念的话，别太长，不要像系统通知。`,
        };
      }
    }
  }

  return null;
}

// Bark 真实状态 → 通知里的 barkStatus 三态（success / failed / skipped）。
// 只有 SUCCESS 才算 success；SKIPPED / NOT_CONFIGURED 属于「未真正发出」→ skipped；
// 其余（FAILED / DENIED / TIMEOUT / UNSUPPORTED）→ failed。绝不把 failed/skipped 伪装成 success。
function barkStatusOf(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESS') return 'success';
  if (s === 'SKIPPED' || s === 'NOT_CONFIGURED') return 'skipped';
  return 'failed';
}

// 主动消息的默认通知：title = 当前助手名字，body = assistantMessage.content（与 Chat 完全一致，同一字符串）。
// 绝不调用 composeNotification 二次生成文案 —— 单一事实来源 = assistantMessage.content。
// 经统一 NotificationEngine 发送（保留权限/审计/BarkProvider 链路）。抽成可注入的 notifyFn，供测试用 spy 替换。
async function sendProactiveNotification({ title, content, conversationId, messageId }) {
  return sendNotification({
    title,
    body: content,
    level: 'normal',
    source: 'proactive',
    conversationId,
    messageId,
  });
}

// 持久化一条站内 proactive 通知（幂等：同一 messageId 只保留一条 proactive 通知，绝不重复）。
// 这是「后端持久化」的唯一入口 —— 即使用户没打开前端，通知也已落库，前端 SYNC.bootstrap() 拉取即可。
// Proactive assistant messages are Chat/Notification events, not AI Activity records.
export async function persistProactiveNotification(userId, { title, body, conversationId, messageId, barkStatus }) {
  return withDoc(userId, (doc) => {
    if (!Array.isArray(doc.notifications)) doc.notifications = [];
    const existing = doc.notifications.find((n) => n && n.source === 'proactive' && n.messageId === messageId);
    if (existing) return { ...existing, reused: true };
    const n = {
      id: randomUUID(),
      type: 'ai',
      title,
      body,
      read: false,
      time: Date.now(),
      source: 'proactive',
      conversationId,
      messageId,
      barkStatus,
    };
    doc.notifications.unshift(n);
    return n;
  });
}

/**
 * 主动消息编排（可测试）：触发判断 → AI 生成 → Conversation 保存（metadata.proactive=true）→ Bark → 站内通知。
 * chatFn / notifyFn 仅供测试注入；生产不传。
 * 返回 { sent, reason, sessionId?, message?, notification?, bark? }：
 *   notification = 落库的站内通知（含 conversationId/messageId/barkStatus）；bark = NotificationEngine 真实状态。
 * 注意：普通主动消息只写 assistant message + 发 Bark + 站内通知，绝不自动创建 AI Activity。
 */
export async function runProactive({ chatFn = chat, notifyFn = sendProactiveNotification, now = new Date() } = {}) {
  const rawApp = await getAppSettings();
  if (!rawApp) return { sent: false, reason: 'disabled' };
  const app = effectiveAppSettings(rawApp);

  const sessionId = await getLatestActiveSessionId();
  if (!sessionId) return { sent: false, reason: 'no_session' };

  // 冷却：两次主动消息最小间隔，防止 cron 重复触发
  const cooldownMin = Number(app.proactive_cooldown_minutes) || 30;
  if (app.proactive_last_at) {
    const gap = (now.getTime() - new Date(app.proactive_last_at).getTime()) / 60000;
    if (gap < cooldownMin) return { sent: false, reason: 'cooldown' };
  }

  const shNow = shanghaiNow(now);
  const today = shanghaiDate(shNow);
  const lastMessageAt = await getLastMessageAt(sessionId);
  const decision = decideProactive(app, shNow, now, lastMessageAt);
  if (!decision) return { sent: false, reason: 'none' };
  const { reason, instruction } = decision;

  // 复用同一套上下文（system + 可见消息 + 记忆摘要），保证语气和记忆一致
  const settings = { ...DEFAULT_SETTINGS, ...((await getSettings(sessionId)) || {}) };
  settings.personal_signature = app.personal_signature;

  // 模型复用「用户当前助手」：与 Chat / 助手 Runtime 同一套 resolveAssistantModel。
  // 绝不从旧 assistant 消息的 metadata.model 猜模型、绝不硬编码 deepseek-chat（回退链由 resolveAssistantModel 内部统一处理）。
  const userId = (await ensureOwner()).id;
  const doc = await getState(userId);
  const model = resolveAssistantModel(doc);
  const built = await buildAIContext({ sessionId, doc, settings, content: '', model, tools: [], callTool: null });
  const task = '【主动发言】' + instruction;
  const systemWithTask = [built.system, task].filter(Boolean).join('\n\n');
  const systemBlocks = built.systemBlocks.length ? [...built.systemBlocks, { type: 'text', text: task }] : null;

  // 协议保障：Anthropic-compatible Messages API 要求 messages 最后一条必须是 user。
  // 生产场景下 built.messages 常以 assistant 结尾（最后一条是助手回复），直接透传会触发 400。
  // 这里只在末尾非 user 时追加一条 synthetic user turn；该条只存在于本次 outbound request 的内存变量，
  // 绝不写入 session / conversation / doc.messages / Activity / Notification，也绝不拼进 system。
  const lastBuilt = built.messages[built.messages.length - 1];
  const messages = lastBuilt && lastBuilt.role === 'user'
    ? built.messages
    : built.messages.concat([{ role: 'user', content: '现在由你主动说点什么吧。' }]);

  const reply = await chatFn({
    model,
    system: systemWithTask,
    systemBlocks,
    messages,
    temperature: settings.temperature,
    maxTokens: settings.max_reply_tokens,
  });

  const content = (reply.content || '').trim();
  if (!content) return { sent: false, reason: 'empty' };

  // 主动消息 → 保存为 assistant message（metadata.proactive=true），进入统一 Conversation，供 Chat 读取。
  const assistantMessage = await createMessage(sessionId, {
    role: 'assistant',
    content,
    reasoningContent: reply.reasoningContent,
    metadata: {
      usage: reply.usage,
      model,
      proactive: true,
      reason,
      contextStats: { ...built.stats, ...normalizeProviderUsage(reply.usage, providerForModel(model), model) },
    },
  });
  await touchSession(sessionId);

  // 记录本次主动消息时间 + 问候日期，防重复
  const patch = { proactive_last_at: now.toISOString() };
  if (reason === 'morning') patch.proactive_last_morning_date = today;
  if (reason === 'noon') patch.proactive_last_noon_date = today;
  if (reason === 'night') patch.proactive_last_night_date = today;
  await saveAppSettings(patch);

  // 通知标题 = 当前助手真实名字（复用 doc.assistants + activeAssistantId，绝不硬编码问候语）。
  // 优先取「该会话绑定的 assistant」，回退全局 activeAssistantId，最后兜底第一个助手 —— 与前端 OS.chat.currentAssistant 同一口径。
  const session = await getSession(sessionId);
  const assistantId = (session && session.assistant_id) || doc.activeAssistantId;
  const assistant = ((doc.assistants || []).find((a) => a && a.id === assistantId))
    || ((doc.assistants || []).find((a) => a && a.id === doc.activeAssistantId))
    || ((doc.assistants || [])[0]);
  const assistantName = (assistant && assistant.name) || (doc.aiSettings && doc.aiSettings.aiName) || 'Bunny';

  // 1) Bark：title = 助手名，body = assistantMessage.content（同一字符串）。失败绝不删除 Chat 消息，也绝不假装成功。
  const bark = await notifyFn({ title: assistantName, content, conversationId: sessionId, messageId: assistantMessage.id });

  // 2) 站内通知：拿到真实 messageId 后落库（幂等）；barkStatus 记录 Bark 真实结果。Bark 失败/跳过时通知仍在。
  const barkStatus = barkStatusOf(bark && bark.status);
  const inApp = await persistProactiveNotification(userId, {
    title: assistantName,
    body: content,
    conversationId: sessionId,
    messageId: assistantMessage.id,
    barkStatus,
  });

  // 主动消息绝不写 AI Activity：本函数全程不调用 create_ai_activity / appendAiActivity / doc.ai.activities.push。
  return { sent: true, reason, sessionId, message: assistantMessage, notification: inApp, bark };
}

/**
 * GET /api/proactive —— 心跳触发点（幂等）
 * 由「前端打开页面」或「外部 cron」调用；内部判断此刻是否该主动发一条。
 * 返回 { sent, reason, sessionId?, message?, notification?, bark? }
 *   reason: disabled | no_session | cooldown | none | empty | morning | noon | night | idle
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await runProactive();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
