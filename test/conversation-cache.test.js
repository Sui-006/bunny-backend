import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConversationCache, saveConversationCache, updateConversationCache, normalizeCache,
} from '../services/conversation-cache.js';
import { createSession, createMessage, listMessages, listMemories } from '../lib/db.js';
import { buildAIContext } from '../lib/context-builder.js';
import { defaultState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';
import { createUser } from '../lib/store.js';

test('saveConversationCache 建立缓存：summary/keyPoints/currentTopic/recentDecisions/openItems/coveredMessageId', async () => {
  const s = await createSession('缓存');
  await createMessage(s.id, { role: 'user', content: '你好' });
  const msgs = await listMessages(s.id, {});
  const last = msgs[msgs.length - 1];

  const cache = await saveConversationCache(s.id, {
    summary: '我们在聊周末计划',
    keyPoints: ['想去爬山', '可能下雨'],
    currentTopic: '周末安排',
    recentDecisions: ['决定周六爬山'],
    openItems: ['确认周日是否去'],
    coveredMessageId: last.id,
  });

  assert.equal(cache.conversationId, s.id);
  assert.equal(cache.summary, '我们在聊周末计划');
  assert.deepEqual(cache.keyPoints, ['想去爬山', '可能下雨']);
  assert.equal(cache.currentTopic, '周末安排');
  assert.deepEqual(cache.recentDecisions, ['决定周六爬山']);
  assert.deepEqual(cache.openItems, ['确认周日是否去']);
  assert.equal(cache.coveredMessageId, last.id);
  assert.ok(cache.updatedAt);

  const got = await getConversationCache(s.id);
  assert.equal(got.summary, '我们在聊周末计划');
  assert.deepEqual(got.keyPoints, ['想去爬山', '可能下雨']);
  assert.equal(got.coveredMessageId, last.id);
});

test('updateConversationCache 增量更新：未提供字段保留，提供字段覆盖', async () => {
  const s = await createSession('增量缓存');
  await saveConversationCache(s.id, { summary: 'A', keyPoints: ['k1'], currentTopic: 't1', recentDecisions: ['d1'], openItems: ['o1'] });
  await updateConversationCache(s.id, { currentTopic: 't2', openItems: ['o2'] });
  const got = await getConversationCache(s.id);
  assert.equal(got.summary, 'A');
  assert.deepEqual(got.keyPoints, ['k1']);
  assert.equal(got.currentTopic, 't2');
  assert.deepEqual(got.recentDecisions, ['d1']);
  assert.deepEqual(got.openItems, ['o2']);
});

test('saveConversationCache 整体覆盖：未提供字段清空', async () => {
  const s = await createSession('覆盖缓存');
  await saveConversationCache(s.id, { summary: 'A', keyPoints: ['k1'], currentTopic: 't1', recentDecisions: ['d1'], openItems: ['o1'] });
  await saveConversationCache(s.id, { summary: 'B' });
  const got = await getConversationCache(s.id);
  assert.equal(got.summary, 'B');
  assert.deepEqual(got.keyPoints, []);
  assert.equal(got.currentTopic, null);
  assert.deepEqual(got.openItems, []);
});

test('Conversation Cache 注入 Chat 上下文（buildAIContext 可读，Chat 与 Proactive 共用此入口）', async () => {
  const s = await createSession('cache-context');
  await createMessage(s.id, { role: 'user', content: '你好' });
  await saveConversationCache(s.id, { summary: '我们在聊天气', keyPoints: ['今天下雨'], currentTopic: '天气', openItems: ['明天是否带伞'] });
  const doc = defaultState();
  const built = await buildAIContext({ sessionId: s.id, doc, settings: {}, content: '明天会下雨吗', model: 'deepseek-chat' });
  assert.ok(built.system.includes('我们在聊天气'), 'summary 注入');
  assert.ok(built.system.includes('当前主题：天气'), 'currentTopic 注入');
  assert.ok(built.system.includes('对话要点：今天下雨'), 'keyPoints 注入');
  assert.ok(built.system.includes('待办/未完成：明天是否带伞'), 'openItems 注入');
});

test('缓存不写长期记忆、不删原始消息（严格分离）', async () => {
  const s = await createSession('隔离缓存');
  await createMessage(s.id, { role: 'user', content: '内容'.repeat(20) });
  await saveConversationCache(s.id, { summary: '缓存摘要', keyPoints: ['要点'] });

  // 原始消息仍在
  const msgs = await listMessages(s.id, {});
  assert.ok(msgs.length >= 1);
  // 长期记忆不污染
  const mems = await listMemories(s.id);
  assert.equal(mems.length, 0);
});

test('save_conversation_cache 工具端到端：tool → permission → cache service 落库', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const s = await createSession('cache-tool');
  const { callTool } = buildDomainTools(user.id, 'test-model', { sessionId: s.id });
  const r = JSON.parse(await callTool('save_conversation_cache', { summary: '工具写的缓存', currentTopic: '测试主题', keyPoints: ['要点A'] }));
  assert.equal(r.code, 'OK');
  assert.equal(r.cache.summary, '工具写的缓存');
  const got = await getConversationCache(s.id);
  assert.equal(got.summary, '工具写的缓存');
  assert.deepEqual(got.keyPoints, ['要点A']);
});

test('normalizeCache 对空行健壮（无缓存列时返回空结构）', async () => {
  const c = normalizeCache(null, 'sid');
  assert.equal(c.conversationId, 'sid');
  assert.deepEqual(c.keyPoints, []);
  assert.equal(c.currentTopic, null);
  assert.deepEqual(c.recentDecisions, []);
  assert.deepEqual(c.openItems, []);
});
