import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAIContext } from '../lib/context-builder.js';
import { BUDGETS, estimateTokens } from '../lib/context-budget.js';
import { defaultState } from '../lib/domain.js';
import { createMemory } from '../services/memory-service.js';
import { createSession, createMessage, saveConversationSummaryIfVersion, touchSummaryStale } from '../lib/db.js';

const mkDoc = () => defaultState();

test('buildAIContext 返回完整结构 + 稳定前缀块带 cache_control', async () => {
  const s = await createSession('结构');
  await createMessage(s.id, { role: 'user', content: '你好' });
  const doc = mkDoc();
  const built = await buildAIContext({ sessionId: s.id, doc, settings: { system_prompt: '我是测试人设' }, content: '你好', model: 'claude-3-5-sonnet' });

  assert.ok(built.system.includes('我是测试人设'));
  assert.ok(Array.isArray(built.systemBlocks));
  assert.equal(built.systemBlocks[0].type, 'text');
  assert.equal(built.systemBlocks[0].cache_control.type, 'ephemeral');
  assert.ok(Array.isArray(built.messages));
  assert.equal(built.messages[built.messages.length - 1].role, 'user');

  for (const k of ['systemTokens', 'memoryTokens', 'summaryTokens', 'domainTokens', 'recentTokens', 'currentMessageTokens', 'toolTokens', 'totalEstimatedTokens', 'summaryHit', 'summaryTriggered', 'costGuardApplied']) {
    assert.ok(k in built.stats, `缺 stats.${k}`);
  }
  assert.equal(typeof built.stats.totalEstimatedTokens, 'number');
});

test('Recent Context 受预算约束，当前消息永远保留', async () => {
  const s = await createSession('预算');
  const orig = BUDGETS.RECENT_CONTEXT_BUDGET;
  BUDGETS.RECENT_CONTEXT_BUDGET = 20;
  try {
    for (let i = 0; i < 10; i++) {
      await createMessage(s.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: '很长的内容'.repeat(20) });
    }
    const doc = mkDoc();
    const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '', model: 'deepseek-chat' });
    assert.equal(built.messages.length, 2); // 1 条最近历史 + 1 条当前
    assert.equal(built.messages[built.messages.length - 1].role, 'assistant'); // 当前消息（最新）
  } finally {
    BUDGETS.RECENT_CONTEXT_BUDGET = orig;
  }
});

test('超长当前消息被截断到 CURRENT_MESSAGE_BUDGET，不破坏原文', async () => {
  const s = await createSession('截断');
  const orig = BUDGETS.CURRENT_MESSAGE_BUDGET;
  BUDGETS.CURRENT_MESSAGE_BUDGET = 50;
  try {
    await createMessage(s.id, { role: 'user', content: 'x'.repeat(1000) });
    const doc = mkDoc();
    const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '', model: 'deepseek-chat' });
    const cur = built.messages[built.messages.length - 1];
    assert.ok(cur.content.includes('已截断'));
    assert.ok(estimateTokens(cur.content) <= BUDGETS.CURRENT_MESSAGE_BUDGET + 10);
  } finally {
    BUDGETS.CURRENT_MESSAGE_BUDGET = orig;
  }
});

test('长期记忆注入 system + memoryTokens 计数', async () => {
  const s = await createSession('记忆');
  await createMessage(s.id, { role: 'user', content: '你好' });
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', summary: '我喜欢安静音乐', source: 'user_explicit' });
  const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '你好', model: 'deepseek-chat' });
  assert.ok(built.system.includes('我喜欢安静音乐'));
  assert.ok(built.stats.memoryTokens > 0);
});

test('摘要命中与 stale 失效', async () => {
  const s = await createSession('摘要');
  await createMessage(s.id, { role: 'user', content: '你好' });
  await saveConversationSummaryIfVersion(s.id, {
    summary: '这是一段对话摘要', summary_version: 1, summarized_until_message_id: null,
    summary_stale: false, summary_updated_at: new Date().toISOString(), summary_token_estimate: 8,
  }, 0);
  const doc = mkDoc();

  const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '', model: 'deepseek-chat' });
  assert.ok(built.system.includes('这是一段对话摘要'));
  assert.equal(built.stats.summaryHit, true);
  assert.ok(built.stats.summaryTokens > 0);

  await touchSummaryStale(s.id);
  const built2 = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '', model: 'deepseek-chat' });
  assert.equal(built2.stats.summaryHit, false);
  assert.ok(!built2.system.includes('这是一段对话摘要'));
});

test('领域上下文按内容相关性注入', async () => {
  const s = await createSession('领域');
  await createMessage(s.id, { role: 'user', content: '我这个月花了多少钱' });
  const doc = mkDoc();
  const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '我这个月花了多少钱', model: 'deepseek-chat' });
  assert.ok(built.system.includes('财务数据'));
  assert.ok(built.stats.domainTokens > 0);
});

test('Cost Guard：总预算超限时 costGuardApplied 标记', async () => {
  const s = await createSession('成本');
  await createMessage(s.id, { role: 'user', content: '内容'.repeat(5000) });
  const doc = mkDoc();
  const orig = BUDGETS.MAX_CONTEXT_TOKENS;
  BUDGETS.MAX_CONTEXT_TOKENS = 1000;
  try {
    const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '', model: 'deepseek-chat' });
    assert.equal(built.stats.costGuardApplied, true);
  } finally {
    BUDGETS.MAX_CONTEXT_TOKENS = orig;
  }
});
