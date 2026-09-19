import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProactive, runProactive, persistProactiveNotification } from '../routes/proactive.js';
import {
  effectiveAppSettings, createSession, createMessage, saveAppSettings, listMessages,
} from '../lib/db.js';
import { getState, aiActivities, withDoc } from '../lib/domain.js';
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

// ---- 测试辅助：造「最新会话」并重置主动消息设置（保证 runProactive 触发早安、无冷却） ----
async function seedProactiveSession() {
  const s = await createSession('主动消息测试');
  await createMessage(s.id, { role: 'user', content: '你好' });
  await saveAppSettings({
    proactive_morning_enabled: true,
    proactive_morning_time: '08:00',
    proactive_last_morning_date: '2026-09-17',
    proactive_last_at: null,
  });
  return s;
}
// 把当前激活助手的名字改成指定值（证明标题取「助手真实名字」而非硬编码问候语）
async function setAssistantName(name) {
  const owner = await ensureOwner();
  await withDoc(owner.id, (doc) => { if (doc.assistants && doc.assistants[0]) doc.assistants[0].name = name; });
}
// 读 owner 的站内通知列表
async function notificationsOf() {
  const owner = await ensureOwner();
  return (await getState(owner.id)).notifications || [];
}

test('runProactive：完整链路 —— assistant message + Bark(body=content,title=助手名) + 站内通知(含 conversationId/messageId) + 不写 Activity', async () => {
  const s = await seedProactiveSession();
  await setAssistantName('小澄');

  const owner = await ensureOwner();
  const activitiesBefore = aiActivities(await getState(owner.id)).length;

  const chatFn = async () => ({ content: '早安呀，今天也要加油哦', reasoningContent: '', usage: null });
  let notified = null;
  const notifyFn = async (payload) => { notified = payload; return { status: 'SUCCESS' }; };

  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'morning');

  // Test 1：assistant message 存在，message.id / conversationId 存在
  const msgs = await listMessages(s.id, { visibleOnly: false });
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, '应保存 assistant 消息');
  assert.ok(assistant.id, 'message.id 存在');
  assert.equal(assistant.metadata.proactive, true);
  assert.equal(assistant.content, '早安呀，今天也要加油哦');
  assert.equal(result.sessionId, s.id);

  // Test 2：Bark body 严格等于 assistantMessage.content
  assert.equal(notified.content, assistant.content);
  // Test 3：Bark title 严格等于助手名（不是问候语/固定文案）
  assert.equal(notified.title, '小澄');
  assert.notEqual(notified.title, '早安问候');
  assert.equal(notified.conversationId, s.id);
  assert.equal(notified.messageId, assistant.id);

  // Test 4：站内通知字段完整（title/body/conversationId/messageId/source）
  const notif = result.notification;
  assert.ok(notif, '应落库站内通知');
  assert.equal(notif.title, '小澄');
  assert.equal(notif.body, assistant.content);
  assert.equal(notif.conversationId, s.id);
  assert.equal(notif.messageId, assistant.id);
  assert.equal(notif.source, 'proactive');
  assert.equal(notif.type, 'ai');

  // Test 5：Bark 成功 → barkStatus success
  assert.equal(notif.barkStatus, 'success');

  // 后端确实持久化（getState 能读到，且不依赖前端 pushNotification）
  const all = await notificationsOf();
  assert.ok(all.some((n) => n.messageId === assistant.id && n.source === 'proactive'), '站内通知已持久化');

  // Test 8：不修改 doc.ai.activities
  const activitiesAfter = aiActivities(await getState(owner.id)).length;
  assert.equal(activitiesAfter, activitiesBefore, '主动消息不应新增 AI Activity');
});

test('runProactive：Bark 失败 → barkStatus=failed，但 assistant message 与站内通知仍在', async () => {
  const s = await seedProactiveSession();
  const chatFn = async () => ({ content: '今天也要记得喝水呀。', reasoningContent: '', usage: null });
  const notifyFn = async () => ({ status: 'FAILED', errorCode: 'ECONNREFUSED' });

  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(result.sent, true);
  assert.equal(result.notification.barkStatus, 'failed');
  // Chat message 仍在（用 result.sessionId —— 即 runProactive 实际选中的会话，避免毫秒级时间戳平局导致选错会话）
  const msgs = await listMessages(result.sessionId, { visibleOnly: false });
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'Bark 失败也不能删 Chat 消息');
  assert.equal(assistant.content, '今天也要记得喝水呀。');
  // 站内通知仍在
  assert.ok(result.notification, 'Bark 失败也不能删站内通知');
  assert.equal(result.notification.body, '今天也要记得喝水呀。');
});

test('runProactive：Bark 跳过（NOT_CONFIGURED）→ barkStatus=skipped，站内通知仍在', async () => {
  const s = await seedProactiveSession();
  const chatFn = async () => ({ content: '晚上早点休息哦。', reasoningContent: '', usage: null });
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });

  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(result.sent, true);
  assert.equal(result.notification.barkStatus, 'skipped');
  assert.equal(result.notification.body, '晚上早点休息哦。');
  const msgs = await listMessages(result.sessionId, { visibleOnly: false });
  assert.ok(msgs.some((m) => m.role === 'assistant'), 'Bark 跳过时 Chat 消息仍在');
});

test('persistProactiveNotification：同一 messageId 重复处理只产生一条 proactive 通知', async () => {
  const owner = await ensureOwner();
  const messageId = 'msg-dup-1';
  const conversationId = 'conv-dup-1';

  const first = await persistProactiveNotification(owner.id, { title: '小澄', body: '你好', conversationId, messageId, barkStatus: 'success' });
  assert.equal(first.reused, undefined);
  assert.ok(first.id);

  const second = await persistProactiveNotification(owner.id, { title: '小澄', body: '你好', conversationId, messageId, barkStatus: 'success' });
  assert.equal(second.reused, true, '第二次处理应复用已有通知');
  assert.equal(second.id, first.id);

  const proactive = (await notificationsOf()).filter((n) => n.source === 'proactive' && n.messageId === messageId);
  assert.equal(proactive.length, 1, '同一 messageId 只能有一条 proactive 通知');
});
