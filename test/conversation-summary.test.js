import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { doSummarize, maybeSummarize, invalidateSummary } from '../services/conversation-summary.js';
import {
  getConversationSummary, saveConversationSummaryIfVersion, listMemories,
  createSession, createMessage,
} from '../lib/db.js';
import { BUDGETS } from '../lib/context-budget.js';
import { config } from '../lib/config.js';

// chat() 用 mock（config.mock=true → 返回占位内容），无需真实 API。
before(() => { config.mock = true; });
after(() => { config.mock = false; });

test('未超阈值：doSummarize 返回 false，不写摘要', async () => {
  const s = await createSession('低');
  await createMessage(s.id, { role: 'user', content: '你好' });
  const ok = await doSummarize(s.id, { model: 'deepseek-chat' });
  assert.equal(ok, false);
  const row = await getConversationSummary(s.id);
  assert.equal(row.summary, null);
});

test('超阈值：doSummarize 生成摘要，设置边界与版本（CAS 版本=1）', async () => {
  const s = await createSession('高');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    await createMessage(s.id, { role: 'user', content: '这是一段比较长的对话内容用于触发摘要'.repeat(3) });
    await createMessage(s.id, { role: 'assistant', content: '回复内容'.repeat(5) });
    const ok = await doSummarize(s.id, { model: 'deepseek-chat' });
    assert.equal(ok, true);
    const row = await getConversationSummary(s.id);
    assert.ok(row.summary);
    assert.equal(row.summary_version, 1);
    assert.equal(row.summary_stale, false);
    assert.ok(row.summarized_until_message_id);
    assert.equal(typeof row.summary_token_estimate, 'number');
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('增量：已有摘要后仅汇总边界后的新消息，版本递增', async () => {
  const s = await createSession('增量');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    await createMessage(s.id, { role: 'user', content: '第一批内容'.repeat(10) });
    await doSummarize(s.id, { model: 'deepseek-chat' });
    const first = await getConversationSummary(s.id);
    const firstUntil = first.summarized_until_message_id;
    assert.equal(first.summary_version, 1);

    await createMessage(s.id, { role: 'user', content: '第二批内容'.repeat(10) });
    await doSummarize(s.id, { model: 'deepseek-chat' });
    const second = await getConversationSummary(s.id);
    assert.equal(second.summary_version, 2);
    assert.notEqual(second.summarized_until_message_id, firstUntil);
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('stale：invalidateSummary 后 doSummarize 从头重建（边界重置）', async () => {
  const s = await createSession('失效');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    await createMessage(s.id, { role: 'user', content: '初始内容'.repeat(10) });
    await doSummarize(s.id, { model: 'deepseek-chat' });
    await invalidateSummary(s.id);
    const stale = await getConversationSummary(s.id);
    assert.equal(stale.summary_stale, true);

    await doSummarize(s.id, { model: 'deepseek-chat' });
    const rebuilt = await getConversationSummary(s.id);
    assert.equal(rebuilt.summary_stale, false);
    assert.equal(rebuilt.summary_version, 2);
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('CAS：版本不符时 saveConversationSummaryIfVersion 返回 false，不覆盖', async () => {
  const s = await createSession('cas');
  const ok1 = await saveConversationSummaryIfVersion(s.id, { summary: 'V1', summary_version: 1 }, 0);
  assert.equal(ok1, true);
  const ok2 = await saveConversationSummaryIfVersion(s.id, { summary: 'V2-被拒', summary_version: 2 }, 0);
  assert.equal(ok2, false);
  const row = await getConversationSummary(s.id);
  assert.equal(row.summary, 'V1');
  assert.equal(row.summary_version, 1);
});

test('Summary 只写 sessions.summary，不写 session memories 表（不污染长期记忆）', async () => {
  const s = await createSession('隔离');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    await createMessage(s.id, { role: 'user', content: '内容'.repeat(20) });
    await doSummarize(s.id, { model: 'deepseek-chat' });
    const mems = await listMemories(s.id);
    assert.equal(mems.length, 0);
    const row = await getConversationSummary(s.id);
    assert.ok(row.summary);
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});

test('maybeSummarize：失败不抛、保留旧摘要（in-flight 去重，重复调用只跑一次）', async () => {
  const s = await createSession('去重');
  const orig = BUDGETS.SUMMARY_THRESHOLD;
  BUDGETS.SUMMARY_THRESHOLD = 10;
  try {
    await createMessage(s.id, { role: 'user', content: '去重内容'.repeat(10) });
    // 并发两次，去重后只有一次生效；结果都应是布尔，不抛异常
    const [a, b] = await Promise.all([
      maybeSummarize(s.id, { model: 'deepseek-chat' }),
      maybeSummarize(s.id, { model: 'deepseek-chat' }),
    ]);
    assert.equal(typeof a, 'boolean');
    assert.equal(typeof b, 'boolean');
    const row = await getConversationSummary(s.id);
    assert.equal(row.summary_version, 1); // 去重保证不并发写两版
  } finally {
    BUDGETS.SUMMARY_THRESHOLD = orig;
  }
});
