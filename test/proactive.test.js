import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProactive, runProactive } from '../routes/proactive.js';
import {
  effectiveAppSettings, createSession, createMessage, saveAppSettings, listMessages,
} from '../lib/db.js';
import { getState, aiActivities } from '../lib/domain.js';
import { ensureOwner } from '../lib/auth.js';

// 直接构造一个「上海墙钟」供 decideProactive 读取（该函数用 getHours/getMinutes 读本地时区）。
const sh = (y, mo, d, hh, mm) => new Date(y, mo - 1, d, hh, mm);

// 构造一个 now，使 shanghaiNow(now) 的本地墙钟恰好 = y-m-d hh:mm（任意时区机器都成立）。
// 依据 shanghaiNow 定义：shanghaiNow(now).getTime() = now.getTime() + (offsetMin + 480)*60000。
function nowAtShanghai(y, mo, d, hh, mm) {
  const target = new Date(y, mo - 1, d, hh, mm).getTime();
  const offsetMin = new Date().getTimezoneOffset();
  return new Date(target - (offsetMin + 480) * 60000);
}

test('effectiveAppSettings：null/undefined 回填默认值，显式 false 保留', () => {
  const eff = effectiveAppSettings({});
  assert.equal(eff.proactive_morning_enabled, true);
  assert.equal(eff.proactive_morning_time, '08:00');
  assert.equal(eff.proactive_noon_enabled, false);
  assert.equal(eff.proactive_night_enabled, true);
  assert.equal(eff.reply_notify_enabled, true);
  assert.equal(eff.proactive_idle_hours, 6);

  const explicit = effectiveAppSettings({ proactive_morning_enabled: false, proactive_noon_enabled: true });
  assert.equal(explicit.proactive_morning_enabled, false);
  assert.equal(explicit.proactive_noon_enabled, true);
});

test('decideProactive：早安窗口内且当天未发 → morning', () => {
  const app = { proactive_morning_enabled: true, proactive_morning_time: '08:00', proactive_last_morning_date: '2026-09-17' };
  const shNow = sh(2026, 9, 18, 8, 30);
  const d = decideProactive(app, shNow, new Date(), null);
  assert.equal(d.reason, 'morning');
  assert.ok(d.instruction.includes('早安'));
});

test('decideProactive：当天已发过早安 → 不再重复', () => {
  const app = { proactive_morning_enabled: true, proactive_morning_time: '08:00', proactive_last_morning_date: '2026-09-18' };
  const shNow = sh(2026, 9, 18, 8, 30);
  assert.equal(decideProactive(app, shNow, new Date(), null), null);
});

test('decideProactive：窗口外（10:00）→ null', () => {
  const app = { proactive_morning_enabled: true, proactive_morning_time: '08:00' };
  const shNow = sh(2026, 9, 18, 10, 0);
  assert.equal(decideProactive(app, shNow, new Date(), null), null);
});

test('decideProactive：开关关闭 → null', () => {
  const app = { proactive_morning_enabled: false, proactive_morning_time: '08:00' };
  const shNow = sh(2026, 9, 18, 8, 30);
  assert.equal(decideProactive(app, shNow, new Date(), null), null);
});

test('decideProactive：空闲 N 小时 → idle', () => {
  const app = { proactive_idle_enabled: true, proactive_idle_hours: 6 };
  const now = new Date();
  const lastMessageAt = new Date(now.getTime() - 7 * 3600000); // 7 小时前
  const d = decideProactive(app, sh(2026, 9, 18, 8, 30), now, lastMessageAt.toISOString());
  assert.equal(d.reason, 'idle');
  assert.ok(d.instruction.includes('小时'));
});

test('runProactive：触发早安 → 保存 assistant 消息（metadata.proactive=true）+ 调 notifyFn + 不写 AI Activity', async () => {
  const s = await createSession('主动消息测试');
  await createMessage(s.id, { role: 'user', content: '你好' });
  await saveAppSettings({
    proactive_morning_enabled: true,
    proactive_morning_time: '08:00',
    proactive_last_morning_date: '2026-09-17',
    proactive_last_at: null,
  });

  const owner = await ensureOwner();
  const activitiesBefore = aiActivities(await getState(owner.id)).length;

  const chatFn = async () => ({ content: '早安呀，今天也要加油哦', reasoningContent: '', usage: null });
  let notified = null;
  const notifyFn = async (payload) => { notified = payload; return { status: 'SUCCESS' }; };

  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'morning');

  // 1. 主动消息进入统一 Conversation（assistant message），metadata.proactive === true
  const msgs = await listMessages(s.id, { visibleOnly: false });
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, '应保存 assistant 消息');
  assert.equal(assistant.metadata.proactive, true);
  assert.equal(assistant.metadata.reason, 'morning');
  assert.equal(assistant.content, '早安呀，今天也要加油哦');

  // 2. 通知经统一入口（notifyFn，生产为 NotificationEngine）发送
  assert.ok(notified, 'notifyFn 应被调用');
  assert.equal(notified.reason, 'morning');
  assert.equal(notified.content, '早安呀，今天也要加油哦');

  // 3. 主动消息 ≠ AI Activity：绝不自动追加动态
  const activitiesAfter = aiActivities(await getState(owner.id)).length;
  assert.equal(activitiesAfter, activitiesBefore, '主动消息不应新增 AI Activity');
});
