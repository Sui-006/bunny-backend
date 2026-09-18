import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STYLE_PROFILE,
  STYLE_SIGNAL_THRESHOLD,
  detectExplicitStylePreference,
  classifyStyleSignal,
  normalizeStyleProfile,
  applyStyleUpdate,
  noteStyleSignal,
  buildStyleContext,
  maybeLearnStyle,
} from '../services/style-profile.js';
import { buildAIContext } from '../lib/context-builder.js';
import { BUDGETS, estimateTokens } from '../lib/context-budget.js';
import { defaultState } from '../lib/domain.js';
import { createUser, getUserState } from '../lib/store.js';
import { createSession, createMessage } from '../lib/db.js';
import { createMemory } from '../services/memory-service.js';

// ---------------- 学习：明确偏好（立即、高置信度） ----------------

test('明确偏好：叫我 XX → address 立即提取', () => {
  const r = detectExplicitStylePreference('以后叫我岁岁');
  assert.equal(r.fields.address, '岁岁');
});

test('明确偏好：不要那么官方 → casual + dislike', () => {
  const r = detectExplicitStylePreference('不要那么官方，自然一点');
  assert.equal(r.fields.formality, 'casual');
  assert.ok(r.dislikes.some((d) => d.includes('官方')));
});

test('明确偏好：以后说话自然一点 → tone natural', () => {
  const r = detectExplicitStylePreference('以后说话自然一点');
  assert.equal(r.fields.tone, 'natural');
});

test('明确偏好：不要每次解释这么长 → concise', () => {
  const r = detectExplicitStylePreference('不要每次解释这么长');
  assert.equal(r.fields.verbosity, 'concise');
});

test('明确偏好：以后详细一点 → detailed（带「以后」锚点）', () => {
  const r = detectExplicitStylePreference('以后回答详细一点');
  assert.equal(r.fields.verbosity, 'detailed');
});

test('明确偏好：别这么像客服 → casual + 客服 dislike', () => {
  const r = detectExplicitStylePreference('别这么像客服');
  assert.equal(r.fields.formality, 'casual');
  assert.ok(r.dislikes.some((d) => d.includes('客服')));
});

// ---------------- 学习：重复行为（达阈值才更新，避免过度推断） ----------------

test('裸风格提示「简单一点」是信号，不是立即的明确偏好', () => {
  assert.equal(detectExplicitStylePreference('简单一点'), null);
  assert.deepEqual(classifyStyleSignal('简单一点'), { key: 'verbosity_concise' });
});

test('信号分类：详细/自然/幽默', () => {
  assert.deepEqual(classifyStyleSignal('详细一点'), { key: 'verbosity_detailed' });
  assert.deepEqual(classifyStyleSignal('说话自然一点'), { key: 'tone_natural' });
  assert.deepEqual(classifyStyleSignal('幽默一点'), { key: 'humor_high' });
});

test('带稳定指令锚点的表达不算重复信号（归明确偏好处理）', () => {
  assert.equal(classifyStyleSignal('以后简单一点'), null);
  assert.equal(classifyStyleSignal('别啰嗦'), null);
});

// ---------------- 拒绝内部协议 / 工具残留 / 隐藏推理 ----------------

test('tool JSON / tool result / XML / hidden reasoning 绝不进入风格来源', () => {
  assert.equal(detectExplicitStylePreference('<function_calls><invoke name="save_memory">简单一点</invoke></function_calls>'), null);
  assert.equal(detectExplicitStylePreference('{"role":"tool","tool_call_id":"x","content":"简单一点"}'), null);
  assert.equal(detectExplicitStylePreference('<thinking>用户喜欢简单</thinking>'), null);
  assert.equal(classifyStyleSignal('<tool_use>详细一点</tool_use>'), null);
  assert.equal(classifyStyleSignal('{"tool_call_id":"abc"}'), null);
});

// ---------------- 数据结构：user-level + 与 Memory/Cache 分离 ----------------

test('Style Profile 是 user-level：不依赖 conversationId，结构里没有 conversationId', () => {
  const doc = defaultState();
  const p = normalizeStyleProfile(doc);
  assert.equal('conversationId' in p, false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'conversationId'), false);
});

test('applyStyleUpdate 合入字段 + 落 version/source/confidence/updatedAt', () => {
  const doc = defaultState();
  const p = applyStyleUpdate(doc, { fields: { verbosity: 'concise', address: '岁岁' }, dislikes: ['不要像客服'] }, { source: 'user_explicit', confidence: 0.95 });
  assert.equal(p.verbosity, 'concise');
  assert.equal(p.address, '岁岁');
  assert.deepEqual(p.dislikes, ['不要像客服']);
  assert.equal(p.source, 'user_explicit');
  assert.equal(p.confidence, 0.95);
  assert.equal(p.version, 1);
  assert.ok(p.updatedAt > 0);
});

test('applyStyleUpdate 无字段变化返回 null（no-op 不落库）', () => {
  const doc = defaultState();
  applyStyleUpdate(doc, { fields: { verbosity: 'concise' } }, { source: 'user_explicit', confidence: 0.95 });
  const again = applyStyleUpdate(doc, { fields: { verbosity: 'concise' } }, { source: 'user_explicit', confidence: 0.95 });
  assert.equal(again, null);
});

test('风格画像不污染长期记忆（memories 数组不受影响）', () => {
  const doc = defaultState();
  createMemory(doc, { category: 'preference', summary: '我喜欢安静音乐', source: 'user_explicit' });
  applyStyleUpdate(doc, { fields: { verbosity: 'concise' } }, { source: 'user_explicit', confidence: 0.95 });
  assert.equal(doc.ai.memories.length, 1);
  assert.equal(doc.ai.memories[0].summary, '我喜欢安静音乐');
});

// ---------------- 上下文注入：轻量 + 预算受控 + 不硬编码助手名 ----------------

test('空画像不注入 styleContext', () => {
  const doc = defaultState();
  assert.equal(buildStyleContext(doc), '');
});

test('styleContext 渲染已设字段 + 不硬编码助手名 + 以用户当前要求为准', () => {
  const doc = defaultState();
  applyStyleUpdate(doc, { fields: { address: '岁岁', verbosity: 'concise', formality: 'casual' } }, { source: 'user_explicit', confidence: 0.95 });
  const s = buildStyleContext(doc);
  assert.ok(s.includes('岁岁'));
  assert.ok(s.includes('简洁'));
  assert.ok(s.includes('以用户当前要求为准'));
  assert.ok(!/Bunny|小澄|小克克/.test(s), '风格画像绝不硬编码助手自己的名字');
});

test('styleContext 受 STYLE_BUDGET 约束（截断后不超预算）', () => {
  const doc = defaultState();
  applyStyleUpdate(doc, { fields: { address: '岁岁', verbosity: 'concise' }, dislikes: ['a', 'b', 'c', 'd', 'e'] }, { source: 'user_explicit', confidence: 0.95 });
  const orig = BUDGETS.STYLE_BUDGET;
  BUDGETS.STYLE_BUDGET = 30;
  try {
    const s = buildStyleContext(doc);
    assert.ok(estimateTokens(s) <= 30 + 10);
    assert.ok(s.includes('已截断') || estimateTokens(s) <= 30);
  } finally {
    BUDGETS.STYLE_BUDGET = orig;
  }
});

// ---------------- 跨窗口继承：新 conversation 读同一个 user-level 画像 ----------------

test('新开 conversation 第一轮可读取 user-level Style Profile（跨窗口继承）', async () => {
  const doc = defaultState();
  applyStyleUpdate(doc, { fields: { address: '岁岁', verbosity: 'concise' } }, { source: 'user_explicit', confidence: 0.95 });

  // 会话 A 与全新的会话 B：都只依赖同一个 doc（用户级），画像都能注入
  const sA = await createSession('A');
  await createMessage(sA.id, { role: 'user', content: '你好' });
  const builtA = await buildAIContext({ sessionId: sA.id, doc, settings: {}, content: '你好', model: 'deepseek-chat' });
  assert.ok(builtA.system.includes('岁岁'));
  assert.ok(builtA.stats.styleTokens > 0);

  const sB = await createSession('B'); // 全新窗口，无任何消息
  const builtB = await buildAIContext({ sessionId: sB.id, doc, settings: {}, content: '继续刚才的话题', model: 'deepseek-chat' });
  assert.ok(builtB.system.includes('岁岁'), '新窗口同样能读到 user-level 画像');
});

// ---------------- 每轮编排：明确→立即、重复→阈值、其它→不写库 ----------------

test('普通消息不触发任何写库（version 不变）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const r = await maybeLearnStyle(user.id, '今天天气不错');
  assert.deepEqual(r, { updated: false, reason: 'none' });
  const raw = await getUserState(user.id);
  assert.equal(raw.version, undefined, '无命中消息绝不写库（version 未被 bump）');
});

test('明确偏好立即更新画像（version bump + address 落库）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const r = await maybeLearnStyle(user.id, '以后叫我岁岁');
  assert.equal(r.updated, true);
  assert.equal(r.reason, 'explicit');
  const raw = await getUserState(user.id);
  assert.equal(raw.ai.styleProfile.address, '岁岁');
  assert.equal(raw.version, 2);
});

test('单次「简单一点」不永久改画像；重复达到阈值才更新', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });

  const r1 = await maybeLearnStyle(user.id, '这个简单一点');
  assert.equal(r1.updated, false);
  assert.equal(r1.reason, 'signal_counted');
  let raw = await getUserState(user.id);
  assert.ok(!raw.ai.styleProfile.verbosity, '单次行为不永久改画像');
  assert.equal(raw.ai.styleSignals[0].count, 1);

  const r2 = await maybeLearnStyle(user.id, '还是简单一点');
  assert.equal(r2.updated, true);
  assert.equal(r2.reason, 'repeated');
  raw = await getUserState(user.id);
  assert.equal(raw.ai.styleProfile.verbosity, 'concise', '重复达阈值才写入');
  assert.equal(raw.ai.styleProfile.source, 'repeated_behavior');
});

test('明确偏好优先级最高：覆盖已存在的相反画像', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  // 先建立「简洁」画像（重复两次）
  await maybeLearnStyle(user.id, '简单一点');
  await maybeLearnStyle(user.id, '简单一点');
  // 明确「以后详细一点」应覆盖
  const r = await maybeLearnStyle(user.id, '以后详细一点');
  assert.equal(r.updated, true);
  const raw = await getUserState(user.id);
  assert.equal(raw.ai.styleProfile.verbosity, 'detailed');
});

test('tool JSON / hidden reasoning 即使出现在消息里也不写入画像', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const r = await maybeLearnStyle(user.id, '<function_calls><invoke>保存简单偏好</invoke></function_calls>');
  assert.equal(r.reason, 'none');
  const raw = await getUserState(user.id);
  assert.equal(raw.version, undefined, 'tool/XML 消息绝不写库');
  assert.ok(!raw.ai?.styleProfile?.verbosity);
});
