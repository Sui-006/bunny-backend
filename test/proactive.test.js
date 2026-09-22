import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProactive, runProactive, persistProactiveNotification } from '../routes/proactive.js';
import {
  effectiveAppSettings, createSession, createMessage, saveAppSettings, listMessages, getLastUserMessageAt,
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

test('decideProactive：空闲计时从当天白天第一条用户消息开始 → idle', () => {
  const app = { proactive_idle_enabled: true, proactive_idle_hours: 6, proactive_morning_time: '08:00', proactive_night_time: '22:00' };
  const now = nowAtShanghai(2026, 9, 18, 15, 0);          // 15:00 白天
  const lastUser = nowAtShanghai(2026, 9, 18, 9, 0);      // 09:00 当天白天，恰好 6 小时前
  const d = decideProactive(app, sh(2026, 9, 18, 15, 0), now, lastUser.toISOString());
  assert.equal(d.reason, 'idle');
  assert.ok(d.instruction.includes('小时'));
});

test('decideProactive：晚安后到当天白天第一条消息前 → 不计空闲（昨夜沉默不累计）', () => {
  const app = { proactive_idle_enabled: true, proactive_idle_hours: 6, proactive_morning_time: '08:00', proactive_night_time: '22:00' };
  const now = nowAtShanghai(2026, 9, 18, 10, 0);          // 上午 10:00
  const lastUser = nowAtShanghai(2026, 9, 17, 23, 0);     // 昨晚 23:00 晚安
  assert.equal(decideProactive(app, sh(2026, 9, 18, 10, 0), now, lastUser.toISOString()), null);
});

test('decideProactive：凌晨属于睡眠时间 → 即使超 N 小时也不发空闲', () => {
  const app = { proactive_idle_enabled: true, proactive_idle_hours: 6, proactive_morning_time: '08:00', proactive_night_time: '22:00' };
  const now = nowAtShanghai(2026, 9, 18, 3, 0);           // 凌晨 3 点
  const lastUser = nowAtShanghai(2026, 9, 17, 20, 0);     // 昨晚 20:00
  assert.equal(decideProactive(app, sh(2026, 9, 18, 3, 0), now, lastUser.toISOString()), null);
});

test('decideProactive：今天用户还没开口 → 不发空闲（即使已超 N 小时）', () => {
  const app = { proactive_idle_enabled: true, proactive_idle_hours: 6, proactive_morning_time: '08:00', proactive_night_time: '22:00' };
  const now = nowAtShanghai(2026, 9, 18, 15, 0);
  const lastUser = nowAtShanghai(2026, 9, 16, 15, 0);     // 两天前
  assert.equal(decideProactive(app, sh(2026, 9, 18, 15, 0), now, lastUser.toISOString()), null);
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
// 把「激活助手」的模型改成指定值（同时确保 activeAssistantId 指向它，让 resolveAssistantModel 命中）
async function setAssistantModel(model) {
  const owner = await ensureOwner();
  await withDoc(owner.id, (doc) => {
    if (doc.assistants && doc.assistants[0]) {
      doc.assistants[0].model = model;
      doc.activeAssistantId = doc.assistants[0].id;
    }
  });
}
// 读 owner 的站内通知列表
async function notificationsOf() {
  const owner = await ensureOwner();
  return (await getState(owner.id)).notifications || [];
}
// 打破毫秒级时间戳平局：确保本测试新造消息的 created_at 严格晚于之前测试，
// 避免 getLatestActiveSessionId 因时间戳相同而选错会话（iso() 只精确到毫秒）。
const tick = () => new Promise((r) => setTimeout(r, 5));

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

// ---- 模型解析回归：proactive 必须复用 resolveAssistantModel（激活助手），绝不猜历史 metadata.model ----

test('runProactive：模型取「激活助手」而非历史 assistant 消息的 metadata.model', async () => {
  await setAssistantModel('claude-sonnet-5');
  // 历史：最后一条 assistant 回复曾用 deepseek-chat（旧 model），与当前激活助手 claude-sonnet-5 不一致
  const s = await seedProactiveSession();
  await createMessage(s.id, { role: 'assistant', content: '在的呀', metadata: { model: 'deepseek-chat' } });

  let capturedModel = null;
  const chatFn = async (args) => { capturedModel = args.model; return { content: '早安呀', reasoningContent: '', usage: null }; };
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });

  await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(capturedModel, 'claude-sonnet-5');
});

test('runProactive：无历史 assistant metadata.model 时仍取「激活助手」，绝不回退 deepseek-chat', async () => {
  await setAssistantModel('claude-sonnet-5');
  // 只有 user 消息，没有任何 assistant 消息 / metadata.model
  await seedProactiveSession();

  let capturedModel = null;
  const chatFn = async (args) => { capturedModel = args.model; return { content: '早安呀', reasoningContent: '', usage: null }; };
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });

  await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(capturedModel, 'claude-sonnet-5');
});

// ---- G2 回归：Anthropic-compatible Messages API 要求末条为 user；synthetic user 只进 outbound，绝不落库 ----

test('runProactive：末条为 assistant 时 outbound messages 追加一条 synthetic user，历史顺序不变且绝不落库', async () => {
  // 复现生产：正常聊天 user→assistant 交替后，最后一条通常是 assistant 回复。
  await tick();
  const s = await seedProactiveSession();
  await createMessage(s.id, { role: 'assistant', content: '今天还不错呀', metadata: { model: 'deepseek-chat' } });

  let captured = null;
  const chatFn = async (args) => { captured = args; return { content: '诊断文案', reasoningContent: '', usage: null }; };
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });
  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  // 确认选中的正是本测试构造的会话（历史 = user「你好」+ assistant「今天还不错呀」）
  assert.equal(result.sessionId, s.id);

  // 1) outbound 比 built 历史多 1 条
  const msgs = captured.messages;
  assert.ok(Array.isArray(msgs), 'chatFn 收到 messages 数组');
  assert.equal(msgs.length, 3, '历史 2 条 + 1 条 synthetic user');
  // 2) 最后一条是 user
  assert.equal(msgs[msgs.length - 1].role, 'user');
  // 3) 最后一条内容固定为 synthetic user 文案
  assert.equal(msgs[msgs.length - 1].content, '现在由你主动说点什么吧。');
  // 4) 原历史顺序不变
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '你好');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '今天还不错呀');
  // 5) 原 assistant 消息仍在
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content === '今天还不错呀'));

  // 6) synthetic user 绝不落库：数据库/session/history 中没有这条 user 消息
  const persisted = await listMessages(result.sessionId, { visibleOnly: false });
  assert.ok(!persisted.some((m) => m.role === 'user' && m.content === '现在由你主动说点什么吧。'),
    'synthetic user 绝不能写入数据库/session/history');
  // 数据库中 user 消息只有原来那 1 条（「你好」），proactive 只追加 assistant 回复
  const userMsgs = persisted.filter((m) => m.role === 'user');
  assert.equal(userMsgs.length, 1, 'user 消息数量不变（无 synthetic user 落库）');
  assert.equal(userMsgs[0].content, '你好');
});

test('runProactive：末条已为 user 时不再追加第二条 synthetic user', async () => {
  // 只有一条 user 消息、没有任何 assistant 消息 → built.messages 以 user 结尾
  await tick();
  const s = await seedProactiveSession();

  let captured = null;
  const chatFn = async (args) => { captured = args; return { content: '早安呀', reasoningContent: '', usage: null }; };
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });
  const result = await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  assert.equal(result.sessionId, s.id);
  const msgs = captured.messages;
  assert.equal(msgs.length, 1, '末条已是 user，不应追加 synthetic user');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '你好');
  assert.ok(!msgs.some((m) => m.content === '现在由你主动说点什么吧。'), '不得出现 synthetic user');
});

test('runProactive：注入 get_current_time 只读时间工具（且绝不放开写工具）', async () => {
  await seedProactiveSession();

  let captured = null;
  const chatFn = async (args) => { captured = args; return { content: '早安呀', reasoningContent: '', usage: null }; };
  const notifyFn = async () => ({ status: 'NOT_CONFIGURED' });

  await runProactive({ chatFn, notifyFn, now: nowAtShanghai(2026, 9, 18, 8, 30) });

  // 只注入 get_current_time 一个工具，绝不带入任何业务写工具
  assert.ok(Array.isArray(captured.tools), 'chatFn 收到 tools 数组');
  assert.equal(captured.tools.length, 1, '只注入 1 个工具');
  assert.equal(captured.tools[0].name, 'get_current_time');

  // callTool 能执行 get_current_time（返回真实上海时间），并拒绝其它任何工具
  assert.equal(typeof captured.callTool, 'function');
  const timeResult = JSON.parse(await captured.callTool('get_current_time', {}));
  assert.equal(timeResult.code, 'OK');
  assert.equal(timeResult.timezone, 'Asia/Shanghai');
  assert.match(timeResult.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(timeResult.localTime, /^\d{2}:\d{2}:\d{2}$/);
  await assert.rejects(() => captured.callTool('create_ai_activity', {}), /未知工具/);
});
