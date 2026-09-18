// 回归测试：AI Activity / AI Memory / System Activity 三者分离 + 统一 AI 自我上下文 + get_current_time。
// 覆盖：Activity 真实落库、Activity ≠ Memory、不重复、结构化过滤、update/delete 审计、
//       Journal 不触发 Activity、统一上下文包含时间/心情/动态、失败不假成功。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState, appendAiActivity, isAiActivity, aiActivities } from '../lib/domain.js';
import { buildDomainTools, AI_SELF_TOOL_NAMES } from '../lib/tools.js';
import { aiCan } from '../lib/permissions.js';
import { buildAISelfContext } from '../lib/context-builder.js';
import { currentTimeInfo, intensityLabel } from '../lib/time.js';

// 造一个用户 + 返回 callTool（内存后端，不碰真实 DB / 网络）
async function mkTool(state = {}) {
  const user = await createUser({ email: null, passwordHash: null, state });
  const dt = buildDomainTools(user.id, 'test-model');
  return { userId: user.id, callTool: dt.callTool };
}

// ---------- 1/2/21/22：Activity 与 Memory 完全独立 ----------

test('AI 创建 Activity → 数据库真实出现一条，且不自动创建 Memory', async () => {
  const { userId, callTool } = await mkTool();
  const r = JSON.parse(await callTool('create_ai_activity', { content: '今天突然想和你说句话。' }));
  assert.equal(r.code, 'CREATED');
  assert.ok(r.activity.id);
  assert.equal(r.activity.actor, 'assistant');
  assert.equal(r.activity.entityType, 'activity');
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 1);
  assert.equal(state.ai.activities[0].text, '今天突然想和你说句话。');
  assert.equal(state.ai.memories.length, 0); // 不强制写 Memory
});

test('Activity 可只有 Activity；与 save_memory 独立（可同时有，也可只删 Activity 不动 Memory）', async () => {
  const { userId, callTool } = await mkTool();
  await callTool('create_ai_activity', { content: '你今天完成了好多事情。' });
  await callTool('save_memory', { category: 'preference', key: 'likes_night_music', value: '喜欢晚上听歌', summary: '喜欢晚上听歌', source: 'user_explicit', userConfirmed: true });
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 1);
  assert.ok(state.ai.memories.length >= 1);
  const del = JSON.parse(await callTool('delete_ai_activity', { id: state.ai.activities[0].id }));
  assert.equal(del.code, 'DELETED');
  const s2 = await getState(userId);
  assert.equal(s2.ai.activities.length, 0);
  assert.ok(s2.ai.memories.length >= 1); // 记忆仍在
});

test('Activity 内容不受「长期记忆」限制：任意自由表达都能写', async () => {
  const { userId, callTool } = await mkTool();
  for (const text of ['嗯，我现在有一点点开心。', '刚刚看到你完成计划，想偷偷记一下。', '今天的天气让我想到你。']) {
    const r = JSON.parse(await callTool('create_ai_activity', { content: text }));
    assert.equal(r.code, 'CREATED');
  }
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 3);
});

// ---------- 4/5：不重复 ----------

test('同一次 tool call 只产生一条动态；重复创建各自独立、无重复 id', async () => {
  const { userId, callTool } = await mkTool();
  const r = JSON.parse(await callTool('create_ai_activity', { content: '刚刚突然想和你说句话。' }));
  assert.equal(r.code, 'CREATED');
  assert.equal((await getState(userId)).ai.activities.length, 1); // 单次调用 = 单条
  await callTool('create_ai_activity', { content: '看到你完成了今天的计划。' });
  const s2 = await getState(userId);
  assert.equal(s2.ai.activities.length, 2);
  assert.equal(new Set(s2.ai.activities.map((a) => a.id)).size, 2); // 无重复 id
});

// ---------- 8/9/10：get_current_time 只读 ----------

test('get_current_time 返回真实时间字段，且不修改数据库', async () => {
  const { userId, callTool } = await mkTool();
  const before = JSON.stringify((await getState(userId)).ai);
  const r = JSON.parse(await callTool('get_current_time', {}));
  assert.equal(r.code, 'OK');
  assert.ok(r.currentTime && r.timezone && r.localDate && r.localTime && r.weekday);
  assert.equal(r.timezone, 'Asia/Shanghai');
  const after = JSON.stringify((await getState(userId)).ai);
  assert.equal(after, before); // ai 子文档无任何改动（get_current_time 只读，不落库）
});

test('get_current_time 是 AI 自我工具，始终可用（不需 WRITE 权限/不审计）', () => {
  assert.ok(AI_SELF_TOOL_NAMES.includes('get_current_time'));
  assert.ok(AI_SELF_TOOL_NAMES.includes('create_ai_activity'));
  assert.ok(AI_SELF_TOOL_NAMES.includes('get_ai_activities'));
  assert.ok(AI_SELF_TOOL_NAMES.includes('update_ai_activity'));
  assert.ok(AI_SELF_TOOL_NAMES.includes('delete_ai_activity'));
});

// ---------- 13/14/15/16：结构化过滤，绝不靠文字 ----------

test('isAiActivity：只认 actor=assistant / entityType=activity，系统/用户条目一律排除', () => {
  assert.equal(isAiActivity({ actor: 'assistant', entityType: 'activity' }), true);
  assert.equal(isAiActivity({ entityType: 'activity' }), true);
  assert.equal(isAiActivity({ actor: 'assistant' }), true);
  assert.equal(isAiActivity({ actor: 'system', entityType: 'sync', text: '同步完成' }), false);
  assert.equal(isAiActivity({ actor: 'user', entityType: 'journal', text: '今天好累' }), false);
  assert.equal(isAiActivity({ entityType: 'task', text: '完成任务' }), false);
  assert.equal(isAiActivity(null), false);
});

test('aiActivities：过滤后只剩 AI 动态，系统/用户条目不出现', () => {
  const doc = { ai: { activities: [
    { id: 'a1', text: 'AI 动态', actor: 'assistant', entityType: 'activity' },
    { id: 's1', text: '同步完成', actor: 'system', entityType: 'sync' },
    { id: 'j1', text: '今天好累', actor: 'user', entityType: 'journal' },
    { id: 'a2', text: '又一条', entityType: 'activity' },
  ] } };
  const acts = aiActivities(doc);
  assert.equal(acts.length, 2);
  assert.ok(acts.every((a) => isAiActivity(a)));
  assert.equal(acts.map((a) => a.id).sort().join(','), 'a1,a2');
});

// ---------- 17/18：update/delete 审计（before 快照） ----------

test('AI 修改 Activity → 落 assistant 审计（before/after）', async () => {
  const { userId, callTool } = await mkTool();
  const c = JSON.parse(await callTool('create_ai_activity', { content: '原来的动态' }));
  const id = c.activity.id;
  const u = JSON.parse(await callTool('update_ai_activity', { id, text: '改过的动态' }));
  assert.equal(u.code, 'UPDATED');
  const state = await getState(userId);
  assert.equal(state.ai.activities[0].text, '改过的动态');
  const log = state.ai.auditLog.find((a) => a.entityType === 'activity' && a.entityId === id && a.action === 'update');
  assert.ok(log);
  assert.equal(log.actor, 'assistant');
  assert.equal(log.before.text, '原来的动态');
  assert.equal(log.after.text, '改过的动态');
});

test('AI 删除 Activity → 真实删除 + 保留 before 快照审计', async () => {
  const { userId, callTool } = await mkTool();
  const c = JSON.parse(await callTool('create_ai_activity', { content: '要被删掉的动态' }));
  const id = c.activity.id;
  const d = JSON.parse(await callTool('delete_ai_activity', { id }));
  assert.equal(d.code, 'DELETED');
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 0); // 真实删除，不是 UI 隐藏
  const log = state.ai.auditLog.find((a) => a.entityType === 'activity' && a.entityId === id && a.action === 'delete');
  assert.ok(log);
  assert.equal(log.actor, 'assistant');
  assert.equal(log.before.text, '要被删掉的动态');
});

test('AI 不能修改/删除非 AI 自己的动态（系统/用户条目 DENIED）', async () => {
  const { callTool } = await mkTool({ ai: { activities: [{ id: 'sys1', text: '同步完成', actor: 'system', entityType: 'sync' }] } });
  assert.equal(JSON.parse(await callTool('update_ai_activity', { id: 'sys1', text: 'x' })).code, 'DENIED');
  assert.equal(JSON.parse(await callTool('delete_ai_activity', { id: 'sys1' })).code, 'DENIED');
});

// ---------- 10/11/12：Journal 只读，不触发 Activity ----------

test('get_journal 只读用户日志，不自动创建 AI Activity', async () => {
  const { userId, callTool } = await mkTool({ journal: [{ id: 'j1', date: '2026-09-18', content: '今天好累', mood: '累' }] });
  const r = JSON.parse(await callTool('get_journal', { limit: 5 }));
  assert.equal(r.code, 'OK');
  assert.equal(r.journal.length, 1);
  assert.equal(r.journal[0].content, '今天好累');
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 0); // 读日志 ≠ 写动态
});

// ---------- 6/7/16/19/20：统一 AI 自我上下文 ----------

test('buildAISelfContext 包含时间 + 心情 + 最近 AI 动态（来自真实数据，系统条目不混入）', () => {
  const doc = { ai: {
    states: [{ emotion: '委屈', intensity: 1, reason: '你一直没理我', acknowledged: false, createdAt: Date.now(), expiresAt: Date.now() + 3600000 }],
    activities: [
      { id: 'a1', text: '刚刚突然想和你说句话。', actor: 'assistant', entityType: 'activity', time: Date.now() },
      { id: 's1', text: '同步完成', actor: 'system', entityType: 'sync', time: Date.now() },
    ],
  } };
  const ctx = buildAISelfContext(doc);
  assert.ok(ctx.includes('现在：'));
  assert.ok(ctx.includes('委屈'));
  assert.ok(ctx.includes('刚刚突然想和你说句话。'));
  assert.ok(!ctx.includes('同步完成')); // 系统日志绝不进 AI 自我上下文
});

test('buildAISelfContext 无状态/无动态时仍返回时间（不报错）', () => {
  const ctx = buildAISelfContext({ ai: { states: [], activities: [] } });
  assert.ok(ctx.includes('现在：'));
});

test('proactive 写入的 Activity 也进入统一上下文（source=proactive）', () => {
  const doc = { ai: { activities: [] } };
  appendAiActivity(doc, { type: 'chat', text: '刚刚突然想找你说句话。', source: 'proactive', reason: 'idle' });
  const acts = aiActivities(doc);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].source, 'proactive');
  assert.ok(buildAISelfContext(doc).includes('刚刚突然想找你说句话。'));
});

// ---------- 23：失败不显示成功 ----------

test('create_ai_activity 空内容 → FAILED，不落库（绝不假成功）', async () => {
  const { userId, callTool } = await mkTool();
  const r = JSON.parse(await callTool('create_ai_activity', { content: '   ' }));
  assert.equal(r.code, 'FAILED');
  const state = await getState(userId);
  assert.equal(state.ai.activities.length, 0);
});

// ---------- 时间纯函数 ----------

test('currentTimeInfo / intensityLabel 纯函数', () => {
  const t = currentTimeInfo(new Date('2026-09-18T00:00:00Z'));
  assert.equal(t.timezone, 'Asia/Shanghai');
  assert.equal(t.localDate, '2026-09-18');
  assert.equal(t.localTime, '08:00:00'); // UTC+8
  assert.ok(typeof t.weekday === 'string' && t.weekday.length > 0);
  assert.equal(intensityLabel(0), '一点点');
  assert.equal(intensityLabel(1), '有一点');
  assert.equal(intensityLabel(5), '非常强');
  assert.equal(intensityLabel(99), '非常强'); // clamp
});
