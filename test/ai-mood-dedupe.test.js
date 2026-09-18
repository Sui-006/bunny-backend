// 回归测试：AI 心情短窗口幂等去重（Bug 2 修复验证）。
// 覆盖：同一心情短时间重复 → 第二次不落库；超窗口 → 允许；A→B→A → 允许；
//       不同会话/不同用户 → 绝不互相去重；retry 重复执行 → 不产生重复；emotion+reason 是去重键。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState, findRecentMoodDuplicate, AI_MOOD_ACTIVITY_DEDUPE_WINDOW_MS } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';

// 造一个用户 + 返回 callTool（内存后端，不碰真实 DB / 网络）
async function mkTool(state = {}, sessionId = 'sess-1') {
  const user = await createUser({ email: null, passwordHash: null, state });
  const dt = buildDomainTools(user.id, 'test-model', { sessionId });
  return { userId: user.id, callTool: dt.callTool };
}

// ---------- 5：同一心情短时间重复 → 第一次创建、第二次不创建 ----------

test('同一个 mood 短时间重复：第一次 CREATED，第二次 IGNORED 不重复写入', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题，认真想了，也认真答了' }));
  assert.equal(r1.code, 'CREATED');
  const r2 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题，认真想了，也认真答了' }));
  assert.equal(r2.code, 'IGNORED');
  assert.equal(r2.reason, 'duplicate_mood');
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 1); // 只保留第一条，第二条不落库
});

test('相同 mood 因 retry 重复执行（同一会话内）：不产生重复 Activity/State', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  // 模拟模型/网络 retry：同一会话内连续两次完全相同的 set_ai_state
  await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' });
  await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' });
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 1);
});

// ---------- 6：同一 mood 超过去重窗口后 → 可再次创建 ----------

test('同一个 mood 超过去重窗口后：可以再次创建', async () => {
  const now = Date.now();
  const oldCreatedAt = now - AI_MOOD_ACTIVITY_DEDUPE_WINDOW_MS - 1000;
  const { userId, callTool } = await mkTool({
    ai: { states: [{ id: 'old', emotion: '认真', intensity: 4, reason: '被问了两个很重的问题', createdAt: oldCreatedAt, expiresAt: now + 3600000, acknowledged: false, sourceConversationId: 'sess-1' }] },
  }, 'sess-1');
  const r = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  assert.equal(r.code, 'CREATED'); // 窗口外 = 新的真实事件，绝不永久去重
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 2);
});

// ---------- 7/8：A → B → A 都可存在（绝不永久去重） ----------

test('mood A → B → A：三次都可存在，最后一次 A 是新的状态变化', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  const r2 = JSON.parse(await callTool('set_ai_state', { emotion: '开心', intensity: 3, reason: '你夸我了' }));
  const r3 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'CREATED');
  assert.equal(r3.code, 'CREATED'); // 中间被「开心」隔开，最后一次「认真」不是紧接的重复
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 3);
});

test('相同 emotion 但 reason 明显不同：属于新的真实事件，不去重', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  const r2 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 2, reason: '开始做今天的计划' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'CREATED');
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 2);
});

// ---------- 10/11：不同 conversation / 不同 user 绝不互相去重 ----------

test('不同 conversation 不互相去重（各自是独立事件）', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  const dt2 = buildDomainTools(userId, 'test-model', { sessionId: 'sess-2' });
  const r2 = JSON.parse(await dt2.callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'CREATED'); // 不同会话，不去重
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 2);
});

test('不同 user 绝不互相去重（各自 state 独立）', async () => {
  const a = await mkTool({}, 'sess-1');
  const b = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await a.callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  const r2 = JSON.parse(await b.callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'CREATED');
  assert.equal((await getState(a.userId)).ai.states.length, 1);
  assert.equal((await getState(b.userId)).ai.states.length, 1);
});

// ---------- 去重键 = emotion + reason（同一心情仅强度变化仍视为重复） ----------

test('同一心情仅强度变化：仍视为重复（去重键是 emotion+reason，不含 intensity）', async () => {
  const { userId, callTool } = await mkTool({}, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 2, reason: '被问了两个很重的问题' }));
  const r2 = JSON.parse(await callTool('set_ai_state', { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'IGNORED');
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 1);
});

// ---------- 纯函数：findRecentMoodDuplicate 逐项判定 ----------

test('findRecentMoodDuplicate：窗口边界 + emotion/reason/conversation 逐项判定', () => {
  const now = 1000000;
  const doc = { ai: { states: [
    { emotion: '认真', intensity: 4, reason: '被问了两个很重的问题', createdAt: now - 1000, expiresAt: now + 3600000, sourceConversationId: 'sess-1' },
  ] } };
  // 同 emotion+reason+conversation，窗口内 → 命中
  assert.equal(findRecentMoodDuplicate(doc, { emotion: '认真', reason: '被问了两个很重的问题', conversationId: 'sess-1' }, now).emotion, '认真');
  // 不同 emotion → 不命中
  assert.equal(findRecentMoodDuplicate(doc, { emotion: '开心', reason: '被问了两个很重的问题', conversationId: 'sess-1' }, now), null);
  // 不同 reason → 不命中
  assert.equal(findRecentMoodDuplicate(doc, { emotion: '认真', reason: '别的理由', conversationId: 'sess-1' }, now), null);
  // 不同 conversation → 不命中
  assert.equal(findRecentMoodDuplicate(doc, { emotion: '认真', reason: '被问了两个很重的问题', conversationId: 'sess-2' }, now), null);
  // 超窗口 → 不命中
  assert.equal(findRecentMoodDuplicate(doc, { emotion: '认真', reason: '被问了两个很重的问题', conversationId: 'sess-1' }, now + AI_MOOD_ACTIVITY_DEDUPE_WINDOW_MS + 1), null);
  // 空 states → 不命中
  assert.equal(findRecentMoodDuplicate({ ai: { states: [] } }, { emotion: '认真', reason: 'x' }, now), null);
});
