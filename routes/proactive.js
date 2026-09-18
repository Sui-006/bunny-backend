import { Router } from 'express';
import {
  getAppSettings,
  saveAppSettings,
  getSettings,
  DEFAULT_SETTINGS,
  getLatestActiveSessionId,
  getLastMessageAt,
  listMessages,
  createMessage,
  touchSession,
  effectiveAppSettings,
} from '../lib/db.js';
import { chat, normalizeProviderUsage, providerForModel } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { composeNotification, barkLevelFor } from '../lib/notify.js';
import { sendNotification } from '../lib/notification-engine.js';
import { getState } from '../lib/domain.js';
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

// 主动消息的默认通知：AI 创作标题/正文后经 NotificationEngine 发送（普通通知，绝不 critical/call）。
// 抽成可注入的 notifyFn，供测试用 spy 替换。
async function sendProactiveNotification({ model, reason, content }) {
  const reasonLabel = { morning: '早安问候', noon: '午安问候', night: '晚安问候', idle: '空闲关怀' }[reason] || '主动消息';
  const composed = await composeNotification({
    model,
    context: `类型：${reasonLabel}。AI 主动发了一条消息，内容：${content}`,
  });
  const lvl = composed && composed.type === 'ALARM' ? 'normal' : barkLevelFor(composed?.type);
  return sendNotification({
    title: composed?.title || reasonLabel,
    body: composed?.body || content,
    level: lvl,
    source: 'proactive',
  });
}

/**
 * 主动消息编排（可测试）：触发判断 → AI 生成 → Conversation 保存（metadata.proactive=true）→ 通知。
 * chatFn / notifyFn 仅供测试注入；生产不传。
 * 返回 { sent, reason, sessionId?, message?, notification? }。
 * 注意：普通主动消息只写 assistant message + 发 Bark，绝不自动创建 AI Activity。
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

  // 模型沿用最近一次 AI 回复用过的，兜底默认模型
  const recent = await listMessages(sessionId, { limit: 30, visibleOnly: false });
  let model = config.defaultModel || 'deepseek-chat';
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'assistant' && recent[i].metadata?.model) {
      model = recent[i].metadata.model;
      break;
    }
  }

  const userId = (await ensureOwner()).id;
  const doc = await getState(userId);
  const built = await buildAIContext({ sessionId, doc, settings, content: '', model, tools: [], callTool: null });
  const task = '【主动发言】' + instruction;
  const systemWithTask = [built.system, task].filter(Boolean).join('\n\n');
  const systemBlocks = built.systemBlocks.length ? [...built.systemBlocks, { type: 'text', text: task }] : null;

  const reply = await chatFn({
    model,
    system: systemWithTask,
    systemBlocks,
    messages: built.messages,
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

  // 通知（Bark）：AI 成功则发；失败不删除 Chat 消息，只返回 FAILED，绝不假装成功。
  const notification = await notifyFn({ model, reason, content });

  return { sent: true, reason, sessionId, message: assistantMessage, notification };
}

/**
 * GET /api/proactive —— 心跳触发点（幂等）
 * 由「前端打开页面」或「外部 cron」调用；内部判断此刻是否该主动发一条。
 * 返回 { sent, reason, sessionId?, message?, notification? }
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
