// AI 通知创作器：由 AI 根据事件上下文决定「要不要通知 / 标题 / 正文 / 级别 / 何时提醒」。
// 前端只消费结构化结果，Bark 只负责发送；这里 AI 是「通知内容的作者」和「策略判断者」。

import { chat } from './ai.js';
import { config } from './config.js';

// 通知类型 → Bark level（ALARM 才有 critical/volume/call）
export function barkLevelFor(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'ALARM') return 'alarm';
  if (t === 'TIME_SENSITIVE') return 'time_sensitive';
  return 'normal';
}

function stripFences(s) {
  return String(s || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

const SYSTEM = `你是 Bunny's Home 的智能通知作者。根据事件上下文判断是否值得打扰用户，并撰写自然、贴合上下文的中文通知。
严格只输出 JSON（不要多余文字、不要 markdown 代码块）：
{
  "type": "NORMAL" | "TIME_SENSITIVE" | "ALARM",
  "alarmIntent": false,
  "shouldNotify": false,
  "scheduledAt": null,
  "title": "",
  "body": "",
  "url": null,
  "barkOptions": { "level": null, "sound": null, "volume": null, "call": null, "isArchive": true, "group": null }
}

规则（务必遵守）：
1. type=ALARM 只能在用户明确表达「设闹钟 / 叫我 / 强提醒 / 到点一定要提醒我」等闹钟意图时使用，且 alarmIntent 必须为 true。普通事件再重要也不能升级成 ALARM。
2. type=TIME_SENSITIVE 用于确有时间敏感性、但并非用户要求闹钟的提醒。
3. type=NORMAL 用于普通事件。
4. 不是每个事件都要通知：不值得打扰就 shouldNotify=false。
5. 标题和正文要用自然的中文，贴合上下文，不要机械重复数据库字段。
6. 普通/时间敏感通知 group 用 "bunny-home"；ALARM 用 "bunny-alarm"。
7. 只有 ALARM 才允许 barkOptions.level="critical"、volume=5、call=true。普通和时间敏感通知绝不使用 critical / call。`;

// 让 AI 生成一条结构化通知（只生成，不发送）
export async function composeNotification({ model, context }) {
  try {
    const reply = await chat({
      model: model || config.defaultModel || 'deepseek-chat',
      system: SYSTEM,
      temperature: 0.4,
      maxTokens: 500,
      messages: [{ role: 'user', content: String(context || '') }],
    });
    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    if (!parsed || typeof parsed !== 'object') {
      return { type: 'NORMAL', alarmIntent: false, shouldNotify: false, scheduledAt: null, title: '', body: '', url: null, barkOptions: {} };
    }
    return parsed;
  } catch (e) {
    console.warn('[notify] AI 创作通知失败：', e.message);
    return { type: 'NORMAL', alarmIntent: false, shouldNotify: false, scheduledAt: null, title: '', body: '', url: null, barkOptions: {} };
  }
}

// 把 AI 结构化结果转成可发送的 Bark 参数（含强提醒安全钳制）
export function toBarkArgs(composed, { allowAlarm = false } = {}) {
  const type = String(composed?.type || 'NORMAL').toUpperCase();
  let level = barkLevelFor(type);
  // 防御：除非明确允许（闹钟），否则把 ALARM 降级为普通，绝不擅自 critical
  if (level === 'alarm' && !allowAlarm) level = 'normal';
  const o = composed?.barkOptions || {};
  return {
    title: composed?.title || '',
    body: composed?.body || '',
    level,
    sound: o.sound || undefined,
    volume: o.volume ?? undefined,
    call: o.call ?? undefined,
    group: o.group || undefined,
    isArchive: o.isArchive ?? undefined,
  };
}
