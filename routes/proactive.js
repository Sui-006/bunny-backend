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
} from '../lib/db.js';
import { prepareContext } from '../lib/context.js';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { sendBarkNotification } from '../lib/bark.js';

const router = Router();

// Asia/Shanghai（UTC+8，无夏令时）
function shanghaiNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
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

/**
 * GET /api/proactive —— 心跳触发点（幂等）
 * 由「前端打开页面」或「外部 cron」调用；内部判断此刻是否该主动发一条。
 * 返回 { sent: boolean, reason, sessionId?, message? }
 *   reason: disabled | no_session | cooldown | none | empty | morning | noon | night | idle
 */
router.get('/', async (req, res, next) => {
  try {
    const app = await getAppSettings();
    if (!app) {
      return res.json({ sent: false, reason: 'disabled' });
    }

    const sessionId = await getLatestActiveSessionId();
    if (!sessionId) return res.json({ sent: false, reason: 'no_session' });

    // 冷却：两次主动消息最小间隔，防止 cron 重复触发
    const cooldownMin = Number(app.proactive_cooldown_minutes) || 30;
    const now = new Date();
    if (app.proactive_last_at) {
      const gap = (now.getTime() - new Date(app.proactive_last_at).getTime()) / 60000;
      if (gap < cooldownMin) return res.json({ sent: false, reason: 'cooldown' });
    }

    const shNow = shanghaiNow();
    const today = shanghaiDate(shNow);

    let reason = null;
    let instruction = null;

    const nowMin = shNow.getHours() * 60 + shNow.getMinutes();

    // A. 早安问候（当天没发过，且落在 [时间, +90min) 窗口内，容忍 cron 延迟）
    const morningTime = timeToMinutes(app.proactive_morning_time || '08:00');
    if (
      app.proactive_morning_enabled &&
      morningTime !== null &&
      app.proactive_last_morning_date !== today
    ) {
      if (nowMin >= morningTime && nowMin < morningTime + 90) {
        reason = 'morning';
        instruction = `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条早安问候，自然亲切，简短一点，体现你对 ta 的了解。`;
      }
    }

    // B. 午安问候
    if (!reason) {
      const noonTime = timeToMinutes(app.proactive_noon_time || '12:00');
      if (
        app.proactive_noon_enabled &&
        noonTime !== null &&
        app.proactive_last_noon_date !== today
      ) {
        if (nowMin >= noonTime && nowMin < noonTime + 90) {
          reason = 'noon';
          instruction = `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条午安问候，自然亲切，简短一点，体现你对 ta 的了解。`;
        }
      }
    }

    // C. 晚安问候
    if (!reason) {
      const nightTime = timeToMinutes(app.proactive_night_time || '22:00');
      if (
        app.proactive_night_enabled &&
        nightTime !== null &&
        app.proactive_last_night_date !== today
      ) {
        if (nowMin >= nightTime && nowMin < nightTime + 90) {
          reason = 'night';
          instruction = `现在是${pad2(shNow.getHours())}:${pad2(shNow.getMinutes())}，请主动向用户发一条晚安问候，温柔一点，简短，体现你对 ta 的了解。`;
        }
      }
    }

    // D. 空闲提醒（N 小时没消息）
    if (!reason && app.proactive_idle_enabled && app.proactive_idle_hours) {
      const idleHours = Number(app.proactive_idle_hours);
      const lastAt = await getLastMessageAt(sessionId);
      if (idleHours > 0 && lastAt) {
        const idleMin = (now.getTime() - new Date(lastAt).getTime()) / 60000;
        if (idleMin >= idleHours * 60) {
          reason = 'idle';
          const hrs = Math.max(1, Math.floor(idleMin / 60));
          instruction = `用户已经 ${hrs} 小时没有发消息了，请主动发一条简短自然的关心/想念的话，别太长，不要像系统通知。`;
        }
      }
    }

    if (!reason) return res.json({ sent: false, reason: 'none' });

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

    const { system, messages } = await prepareContext({ sessionId, settings, model });
    const systemWithTask = [system, '【主动发言】' + instruction].filter(Boolean).join('\n\n');

    const reply = await chat({
      model,
      system: systemWithTask,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.max_reply_tokens,
    });

    const content = (reply.content || '').trim();
    if (!content) return res.json({ sent: false, reason: 'empty' });

    const assistantMessage = await createMessage(sessionId, {
      role: 'assistant',
      content,
      reasoningContent: reply.reasoningContent,
      metadata: { usage: reply.usage, model, proactive: true, reason },
    });
    await touchSession(sessionId);

    // 记录本次主动消息时间 + 问候日期，防重复
    const patch = { proactive_last_at: now.toISOString() };
    if (reason === 'morning') patch.proactive_last_morning_date = today;
    if (reason === 'noon') patch.proactive_last_noon_date = today;
    if (reason === 'night') patch.proactive_last_night_date = today;
    await saveAppSettings(patch);

    // 推 Bark 通知到手机
    const titles = { morning: '早安 ☀️', noon: '午安 🌤️', night: '晚安 🌙', idle: '想你了 💬' };
    const title = titles[reason] || '问候 💌';
    await sendBarkNotification(app.bark_url || config.barkUrl, title, content);

    return res.json({ sent: true, reason, sessionId, message: assistantMessage });
  } catch (e) {
    next(e);
  }
});

export default router;
