// Phase 2 回归测试：System Budget hard cap、Global Cost Guard（确定性 + 优先级）、
// Provider usage 归一化、Conversation Summary 边界/失败安全。
// 纯函数测试（buildSystemInstructions / applyGlobalGuard / normalizeProviderUsage）不依赖 DB；
// 边界/失败安全测试走内存 store（useSupabase=false 时 createSession 用内存）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAIContext, buildSystemInstructions, applyGlobalGuard } from '../lib/context-builder.js';
import { BUDGETS, estimateTokens } from '../lib/context-budget.js';
import { normalizeProviderUsage, providerForModel } from '../lib/ai.js';
import { createSession, createMessage, saveConversationSummaryIfVersion, getConversationSummary } from '../lib/db.js';
import { maybeSummarize } from '../services/conversation-summary.js';
import { defaultState } from '../lib/domain.js';

const mkState = (overrides = {}) => ({
  stablePrefix: '',
  summaryText: '',
  domainText: '',
  quotedText: '',
  recentMessages: [],
  currentMessage: null,
  ...overrides,
});

// 与 applyGlobalGuard.excess() 同口径的「当前总 token」（不含 -max）
const totalTokens = (state) =>
  estimateTokens(state.stablePrefix || '')
  + estimateTokens(state.summaryText || '')
  + estimateTokens(state.domainText || '')
  + estimateTokens(state.quotedText || '')
  + state.recentMessages.reduce((s, m) => s + estimateTokens(m.content), 0)
  + (state.currentMessage ? estimateTokens(state.currentMessage.content) : 0);

// ---------------- Task A：SYSTEM_BUDGET hard cap ----------------

test('buildSystemInstructions：低于预算原样保留，不触发截断', () => {
  const r = buildSystemInstructions({ system_prompt: '我是简短人设', personal_signature: '喜欢安静' }, 1000);
  assert.equal(r.truncated, false);
  assert.ok(r.text.includes('我是简短人设'));
  assert.ok(r.text.includes('你是 Bunny')); // 核心规则仍在
});

test('buildSystemInstructions：超预算确定性保留核心规则，绝不随机删块', () => {
  const settings = { system_prompt: '这是一个非常长的人设说明'.repeat(40), personal_signature: '用户自我描述'.repeat(40) };
  const a = buildSystemInstructions(settings, 30);
  const b = buildSystemInstructions(settings, 30);
  assert.equal(a.truncated, true);
  assert.ok(estimateTokens(a.text) <= 30 + 20); // 允许截断提示的少量溢出
  assert.ok(a.text.includes('你是 Bunny')); // RULES_PREAMBLE（最高优先级）先保留
  assert.deepEqual(a, b); // 确定性
});

// ---------------- Task B：Global Cost Guard ----------------

test('applyGlobalGuard：低于预算返回 false，不裁剪任何段', () => {
  const state = mkState({ stablePrefix: '规则', currentMessage: { role: 'user', content: '你好' } });
  const applied = applyGlobalGuard(state, 1000);
  assert.equal(applied, false);
  assert.equal(state.currentMessage.content, '你好');
});

test('applyGlobalGuard：超限优先清空 Recent，Current 最后保留', () => {
  const mk = () => mkState({
    stablePrefix: '稳定规则',
    summaryText: '摘要内容'.repeat(30),
    domainText: '领域数据'.repeat(30),
    recentMessages: Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `历史${i}`.repeat(30) })),
    currentMessage: { role: 'user', content: '当前消息'.repeat(30) },
  });
  const s = mk();
  const applied = applyGlobalGuard(s, 200);
  assert.equal(applied, true);
  assert.equal(s.recentMessages.length, 0); // Recent 从最旧开始全部丢光
  assert.ok(s.currentMessage.content.includes('当前消息')); // Current 非空，最后才动
});

test('applyGlobalGuard：引用动态（quoted）先于当前消息被裁剪', () => {
  const state = mkState({
    stablePrefix: '规则',
    quotedText: '引用内容'.repeat(200), // ~800 tokens，是唯一可压缩的动态大块
    currentMessage: { role: 'user', content: '当前消息'.repeat(50) },
  });
  applyGlobalGuard(state, 300);
  assert.ok(estimateTokens(state.quotedText) < 800); // quoted 被截断
  assert.ok(state.currentMessage.content.includes('当前消息')); // current 保留
});

test('applyGlobalGuard：确定性 —— 同样输入两次输出完全一致', () => {
  const mk = () => mkState({
    stablePrefix: '稳定规则'.repeat(10),
    summaryText: '摘要内容'.repeat(50),
    domainText: '领域数据'.repeat(50),
    quotedText: '引用动态'.repeat(50),
    recentMessages: Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `历史消息${i}`.repeat(40) })),
    currentMessage: { role: 'user', content: '当前提问'.repeat(40) },
  });
  const a = mk();
  const b = mk();
  const ra = applyGlobalGuard(a, 500);
  const rb = applyGlobalGuard(b, 500);
  assert.equal(ra, rb);
  assert.deepEqual(a, b);
});

test('applyGlobalGuard：System / Core Memory 绝不因 cost guard 被删除', () => {
  const state = mkState({
    stablePrefix: '【规则】你是 Bunny。'.repeat(50), // 代表 system+memory（各自已有 hard budget）
    recentMessages: Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: `历史${i}`.repeat(40) })),
    currentMessage: { role: 'user', content: '当前'.repeat(40) },
  });
  applyGlobalGuard(state, 300);
  assert.ok(state.stablePrefix.includes('你是 Bunny')); // stable prefix 原样保留
});

// ---------------- Task C：统一 Context 布局 ----------------

test('布局顺序：Stable Prefix → 摘要 → 动态后缀；messages 末尾是当前消息', async () => {
  const s = await createSession('布局');
  await createMessage(s.id, { role: 'user', content: '我花了多少钱' });
  await createMessage(s.id, { role: 'assistant', content: '回复' });
  await createMessage(s.id, { role: 'user', content: '我这个月花了多少钱' });
  await saveConversationSummaryIfVersion(s.id, {
    summary: '一段对话摘要内容', summary_version: 1, summarized_until_message_id: null,
    summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 10,
  }, 0);
  const built = await buildAIContext({ sessionId: s.id, doc: defaultState(), settings: { system_prompt: '人设' }, content: '我这个月花了多少钱', model: 'deepseek-chat' });

  const sys = built.system;
  const iStable = sys.indexOf('人设');
  const iSummary = sys.indexOf('一段对话摘要内容');
  const iDomain = sys.indexOf('财务数据');
  assert.ok(iStable >= 0 && iSummary >= 0 && iDomain >= 0);
  assert.ok(iStable < iSummary && iSummary < iDomain); // 顺序固定
  assert.equal(built.messages[built.messages.length - 1].role, 'user'); // 当前消息在末尾

  // 只有稳定前缀块带 cache_control，摘要/动态块不带
  assert.equal(built.systemBlocks[0].cache_control.type, 'ephemeral');
  for (const b of built.systemBlocks.slice(1)) assert.equal(b.cache_control, undefined);
});

// ---------------- Task D：Provider usage 归一化 ----------------

test('providerForModel：按模型名判定厂商', () => {
  assert.equal(providerForModel('deepseek-chat'), 'deepseek');
  assert.equal(providerForModel('claude-3-5-sonnet'), 'anthropic');
  assert.equal(providerForModel('gpt-4o'), 'openai');
});

test('normalizeProviderUsage：映射各厂商字段，缺失字段不猜', () => {
  const ds = normalizeProviderUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80 }, 'deepseek', 'deepseek-chat');
  assert.equal(ds.provider, 'deepseek');
  assert.equal(ds.inputTokens, 100);
  assert.equal(ds.outputTokens, 20);
  assert.equal(ds.totalTokens, 120);
  assert.equal(ds.cacheReadTokens, 80);
  assert.equal(ds.cacheCreationTokens, undefined); // 没返回就不猜

  const an = normalizeProviderUsage({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }, 'anthropic', 'claude-3-5-sonnet');
  assert.equal(an.inputTokens, 50);
  assert.equal(an.cacheReadTokens, 30);
  assert.equal(an.cacheCreationTokens, 20);
  assert.equal(an.totalTokens, 60); // input+output 推算

  const none = normalizeProviderUsage(undefined, 'deepseek', 'deepseek-chat');
  assert.equal(none.provider, 'deepseek');
  assert.equal(none.inputTokens, undefined);
});

// ---------------- Task G/H：Summary Boundary + 失败安全 ----------------

test('摘要边界：recent 只从 boundary 之后，摘要不吞边界后消息', async () => {
  const s = await createSession('边界');
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push((await createMessage(s.id, { role: i % 2 ? 'user' : 'assistant', content: `消息${i}内容` })).id);
  // boundary = 第 3 条 → 摘要代表 1-3，recent 只能含 4-5
  await saveConversationSummaryIfVersion(s.id, {
    summary: '摘要代表1到3', summary_version: 1, summarized_until_message_id: ids[2],
    summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 10,
  }, 0);
  const built = await buildAIContext({ sessionId: s.id, doc: defaultState(), settings: {}, content: '', model: 'deepseek-chat' });
  const texts = built.messages.map((m) => m.content);
  assert.ok(texts.every((t) => !t.includes('消息1') && !t.includes('消息2') && !t.includes('消息3')));
  assert.ok(texts.some((t) => t.includes('消息4')));
  assert.ok(texts.some((t) => t.includes('消息5')));
});

test('摘要生成失败：保留旧摘要 / 旧版本 / 旧边界', async () => {
  const s = await createSession('失败');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    const m = await createMessage(s.id, { role: 'user', content: '初始内容'.repeat(10) });
    await saveConversationSummaryIfVersion(s.id, {
      summary: '有效旧摘要', summary_version: 1, summarized_until_message_id: m.id,
      summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 10,
    }, 0);
    await createMessage(s.id, { role: 'user', content: '新增内容'.repeat(10) });
    const ok = await maybeSummarize(s.id, { model: 'deepseek-chat', chatFn: async () => { throw new Error('boom'); } });
    assert.equal(ok, false);
    const row = await getConversationSummary(s.id);
    assert.equal(row.summary, '有效旧摘要');
    assert.equal(row.summary_version, 1);
    assert.equal(row.summarized_until_message_id, m.id);
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('空/畸形摘要：绝不覆盖有效旧摘要', async () => {
  const s = await createSession('空摘要');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    const m = await createMessage(s.id, { role: 'user', content: '初始内容'.repeat(10) });
    await saveConversationSummaryIfVersion(s.id, {
      summary: '有效旧摘要', summary_version: 1, summarized_until_message_id: m.id,
      summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 10,
    }, 0);
    await createMessage(s.id, { role: 'user', content: '新增内容'.repeat(10) });
    const ok = await maybeSummarize(s.id, { model: 'deepseek-chat', chatFn: async () => ({ content: '太短' }) });
    assert.equal(ok, false);
    const row = await getConversationSummary(s.id);
    assert.equal(row.summary, '有效旧摘要');
    assert.equal(row.summary_version, 1);
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('跨会话隔离：session A 的摘要绝不进入 session B', async () => {
  const a = await createSession('隔离A');
  const b = await createSession('隔离B');
  await createMessage(a.id, { role: 'user', content: 'A的内容' });
  await createMessage(b.id, { role: 'user', content: 'B的内容' });
  await saveConversationSummaryIfVersion(a.id, {
    summary: 'A的专属摘要', summary_version: 1, summarized_until_message_id: null,
    summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 10,
  }, 0);
  const builtB = await buildAIContext({ sessionId: b.id, doc: defaultState(), settings: {}, content: '', model: 'deepseek-chat' });
  assert.ok(!builtB.system.includes('A的专属摘要'));
});
