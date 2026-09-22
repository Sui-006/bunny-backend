// 回归测试：AI 心情历史永久保留（过期 ≠ 删除）。
// 覆盖：appendAiState 不再清理过期状态；当前心情推导只看「未过期 + 未回应」且不影响历史；
//       set_ai_state 连续写入历史只增不减（含过期旧数据）；putState/repairState 不裁剪 states。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState, putState, appendAiState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';
import { buildAISelfContext } from '../lib/context-builder.js';

// 造一个用户 + 返回 callTool（内存后端，不碰真实 DB / 网络）
async function mkTool(state = {}, sessionId = 'sess-1') {
  const user = await createUser({ email: null, passwordHash: null, state });
  const dt = buildDomainTools(user.id, 'test-model', { sessionId });
  return { userId: user.id, callTool: dt.callTool };
}

// ---------- A：appendAiState 不再删除过期历史 ----------

test('appendAiState 不删除过期历史：过期心情永久保留，新心情 unshift 到最前', () => {
  const now = Date.now();
  const doc = { ai: { states: [
    { id: 'expired', emotion: '开心', intensity: 1, createdAt: now - 30 * 3600 * 1000, expiresAt: now - 6 * 3600 * 1000, acknowledged: false },
    { id: 'current', emotion: '平静', intensity: 2, createdAt: now - 3600 * 1000, expiresAt: now + 18 * 3600 * 1000, acknowledged: false },
  ] } };
  const s = appendAiState(doc, { emotion: '期待', intensity: 3 });
  assert.equal(doc.ai.states.length, 3);        // 旧的（含过期）都保留
  assert.equal(doc.ai.states[0].id, s.id);      // 新心情在最前
  assert.equal(doc.ai.states[1].id, 'expired'); // 过期的那条仍在
  assert.equal(doc.ai.states[2].id, 'current');
});

// ---------- B：当前心情推导 = 未过期 + 未回应，且不影响历史 ----------

test('当前心情只看「未过期 + 未回应」：过期/已回应不进入当前，但仍在历史', () => {
  const now = Date.now();
  const doc = { ai: { states: [
    { id: 'ack',   emotion: '难过', intensity: 4, createdAt: now - 1000, expiresAt: now + 3600 * 1000, acknowledged: true },
    { id: 'exp',   emotion: '开心', intensity: 3, createdAt: now - 2000, expiresAt: now - 1, acknowledged: false },
    { id: 'valid', emotion: '平静', intensity: 2, createdAt: now - 3000, expiresAt: now + 3600 * 1000, acknowledged: false },
  ] } };
  const ctx = buildAISelfContext(doc);
  assert.ok(ctx.includes('平静'));       // 当前 = 未过期且未回应
  assert.ok(!ctx.includes('难过'));      // 已回应 → 不再作为当前
  assert.ok(!ctx.includes('开心'));      // 已过期 → 不再作为当前
  assert.equal(doc.ai.states.length, 3); // 历史三条都在，一个不少
});

// ---------- C：set_ai_state 连续写入，历史只增不减（含过期旧数据） ----------

test('set_ai_state 连续写入：旧心情（含过期）全部保留，历史只增不减', async () => {
  const now = Date.now();
  const { userId, callTool } = await mkTool({
    ai: { states: [{ id: 'old', emotion: '开心', intensity: 1, createdAt: now - 30 * 3600 * 1000, expiresAt: now - 6 * 3600 * 1000, acknowledged: false }] },
  }, 'sess-1');
  const r1 = JSON.parse(await callTool('set_ai_state', { emotion: '期待', intensity: 3, reason: '想见你' }));
  const r2 = JSON.parse(await callTool('set_ai_state', { emotion: '委屈', intensity: 2, reason: '你一直没理我' }));
  assert.equal(r1.code, 'CREATED');
  assert.equal(r2.code, 'CREATED');
  const state = await getState(userId);
  assert.equal(state.ai.states.length, 3); // old(过期) + 期待 + 委屈 都在
  assert.ok(state.ai.states.some((s) => s.id === 'old')); // 过期历史未删除
});

// ---------- D：putState / repairState 不裁剪 states（含过期/已回应） ----------

test('putState 写穿 repairState：过期/已回应的心情原样保留，不裁剪', async () => {
  const now = Date.now();
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const st = await getState(user.id);
  st.ai.states = [
    { id: 'ack', emotion: '委屈', intensity: 2, createdAt: now, expiresAt: now + 3600 * 1000, acknowledged: true },
    { id: 'exp', emotion: '开心', intensity: 3, createdAt: now - 1, expiresAt: now - 1000, acknowledged: false },
  ];
  const saved = await putState(user.id, st);
  assert.equal(saved.ai.states.length, 2);
  assert.equal(saved.ai.states[0].id, 'ack');
  assert.equal(saved.ai.states[1].id, 'exp');
});
