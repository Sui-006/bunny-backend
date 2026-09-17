import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_CATEGORIES, CONFIRMATION_MODES, LIMITS, CANDIDATE_LIMITS,
  memorySettings, activeAssistantId,
  getMemories, activeMemories, getMemory,
  createMemory, updateMemory, clearMemories,
  getRelevantMemories, buildMemoryContext,
  importanceWeight,
  addCandidate, confirmCandidate, rejectCandidate, getPendingCandidates, cleanupExpiredCandidates,
  decideMemoryAction, proposeMemory,
} from '../services/memory-service.js';
import { withDoc, withDocVersioned, getState } from '../lib/domain.js';
import { saveUserStateIfVersion, createUser } from '../lib/store.js';

// 最小文档：两个助手，激活的是第二个（不是 assistants[0]）
function mkDoc() {
  return {
    assistants: [
      { id: 'a1', name: '一号' },
      { id: 'a2', name: '二号' },
    ],
    activeAssistantId: 'a2',
    ai: { memories: [], memoryCandidates: [], memorySignals: [] },
    memorySettings: { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' },
  };
}

test('importanceWeight 明确排序（critical>high>normal>low，非法回退 1），getRelevantMemories 无 null 引用', () => {
  assert.equal(importanceWeight('critical'), 3);
  assert.equal(importanceWeight('high'), 2);
  assert.equal(importanceWeight('normal'), 1);
  assert.equal(importanceWeight('low'), 0);
  assert.equal(importanceWeight('bogus'), 1);
  const doc = mkDoc();
  createMemory(doc, { summary: '低', importance: 'low' });
  createMemory(doc, { summary: '关键', importance: 'critical' });
  createMemory(doc, { summary: '普通', importance: 'normal' });
  const ids = getRelevantMemories(doc, { query: '' }).map((m) => m.summary);
  assert.equal(ids[0], '关键'); // critical 排最前
});

test('getRelevantMemories 同 category+key 冲突去重，只保留最新一条', () => {
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', key: 'reply_style', summary: '旧偏好' });
  createMemory(doc, { category: 'preference', key: 'reply_style', summary: '新偏好' });
  const list = getRelevantMemories(doc, { query: '' });
  const matched = list.filter((m) => m.key === 'reply_style');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].summary, '新偏好');
});

test('buildMemoryContext 前置说明「以用户当前表达为准」（当前消息 > 旧记忆）', () => {
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', key: 'reply_style', summary: '用户喜欢详细回答' });
  const { text } = buildMemoryContext(doc, { query: '以后请简短一点' });
  assert.ok(text.includes('以用户当前表达为准'));
});

test('buildMemoryContext 注入数量上限 10', () => {
  const doc = mkDoc();
  for (let i = 0; i < 30; i++) createMemory(doc, { category: 'preference', summary: '偏好 ' + i, key: 'k' + i });
  const { memories } = buildMemoryContext(doc, {});
  assert.ok(memories.length <= LIMITS.injectCount);
  assert.equal(memories.length, 10);
});

test('buildMemoryContext 注入字符预算 4000', () => {
  const doc = mkDoc();
  for (let i = 0; i < 10; i++) createMemory(doc, { category: 'preference', summary: '很长的记忆内容'.repeat(60) + i, key: 'k' + i });
  const { text } = buildMemoryContext(doc, {});
  assert.ok(text.length < LIMITS.injectChars + 500, '注入文本受预算约束');
});

test('addCandidate 不进入正式记忆 / 上下文（pending 候选不注入）', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { summary: '候选偏好', category: 'preference', source: 'ai_extracted' });
  assert.ok(c && c.status === 'pending');
  assert.equal(getMemories(doc).length, 0);
  assert.equal(buildMemoryContext(doc, {}).text, '');
});

test('confirmCandidate 转正为正式记忆（userConfirmed=true）', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { summary: '候选偏好', category: 'preference', source: 'ai_extracted' });
  const mem = confirmCandidate(doc, c.id);
  assert.equal(mem.summary, '候选偏好');
  assert.equal(mem.userConfirmed, true);
  assert.equal(getMemories(doc).length, 1);
  assert.equal(getPendingCandidates(doc).length, 0);
});

test('rejectCandidate 标记 rejected，不转正', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { summary: '候选偏好', source: 'ai_extracted' });
  const r = rejectCandidate(doc, c.id);
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejectedCount, 1);
  assert.equal(getMemories(doc).length, 0);
  assert.equal(getPendingCandidates(doc).length, 0);
});

test('cleanupExpiredCandidates 清理过期候选', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { summary: '过期的', source: 'ai_extracted' });
  c.expiresAt = Date.now() - 1000;
  const removed = cleanupExpiredCandidates(doc);
  assert.ok(removed >= 1);
  assert.equal(getPendingCandidates(doc).length, 0);
});

test('decideMemoryAction：explicit_only 忽略推断 / ask_before_save 转候选 / balanced 重复检测', () => {
  const e = mkDoc(); e.memorySettings.confirmationMode = 'explicit_only';
  const re = decideMemoryAction(e, '我喜欢简洁回答');
  assert.equal(re.action, 'ignore');
  assert.equal(re.reason, 'explicit_only');
  assert.equal(decideMemoryAction(e, '记住我喜欢咖啡').action, 'save'); // 明确请求仍保存

  const a = mkDoc(); a.memorySettings.confirmationMode = 'ask_before_save';
  assert.equal(decideMemoryAction(a, '我喜欢简洁回答').action, 'candidate');

  const b = mkDoc(); b.memorySettings.confirmationMode = 'balanced';
  assert.equal(decideMemoryAction(b, '我喜欢简洁回答').action, 'ignore'); // 首次 not_repeated
  assert.equal(decideMemoryAction(b, '我喜欢简洁回答').action, 'candidate'); // 重复
});

test('balanced 完整确认流：重复偏好 → 候选 → 确认 → 转正', () => {
  const doc = mkDoc();
  doc.memorySettings.confirmationMode = 'balanced';
  const p1 = proposeMemory(doc, { category: 'preference', key: 'reply_style', summary: '我喜欢简洁回答', source: 'ai_extracted' });
  assert.equal(p1.action, 'ignore'); // 首次 not_repeated
  const p2 = proposeMemory(doc, { category: 'preference', key: 'reply_style', summary: '我喜欢简洁回答', source: 'ai_extracted' });
  assert.equal(p2.action, 'candidate');
  assert.equal(getMemories(doc).length, 0); // 候选未转正
  const mem = confirmCandidate(doc, p2.candidate.id);
  assert.equal(mem.summary, '我喜欢简洁回答');
  assert.equal(getMemories(doc).length, 1);
});

test('proposeMemory：explicit_only 非显式忽略；重要对话（非偏好）直接进候选', () => {
  const e = mkDoc(); e.memorySettings.confirmationMode = 'explicit_only';
  assert.equal(proposeMemory(e, { category: 'preference', summary: '我喜欢简洁', source: 'ai_extracted' }).action, 'ignore');
  assert.equal(e.ai.memories.length, 0);

  const b = mkDoc(); b.memorySettings.confirmationMode = 'balanced';
  const r = proposeMemory(b, { category: 'important_conversation', summary: '重要约定', value: { keyPoints: ['a'] }, source: 'ai_extracted' });
  assert.equal(r.action, 'candidate'); // 重要对话不要求重复
});

test('createMemory 只改 ai.memories，不覆盖其他 user_state 字段', () => {
  const doc = mkDoc();
  doc.tasks = [{ id: 't1' }];
  doc.profile = { name: '阿明' };
  const tasksRef = doc.tasks, profileRef = doc.profile, msRef = doc.memorySettings;
  createMemory(doc, { summary: '新记忆' });
  assert.equal(doc.tasks, tasksRef);
  assert.equal(doc.profile, profileRef);
  assert.equal(doc.memorySettings, msRef);
  assert.equal(doc.ai.memories.length, 1);
});

test('编辑只更新目标 / 清空只清记忆，不影响其他记忆与 memorySettings', () => {
  const doc = mkDoc();
  const m1 = createMemory(doc, { summary: 'a' });
  const m2 = createMemory(doc, { summary: 'b' });
  updateMemory(doc, m1.id, { summary: 'a2' });
  assert.equal(doc.ai.memories.length, 2);
  assert.ok(getMemory(doc, m2.id)); // 编辑不删其他
  const msBefore = { ...doc.memorySettings };
  clearMemories(doc);
  assert.equal(doc.ai.memories.length, 0);
  assert.deepEqual(doc.memorySettings, msBefore); // 清空不清设置
});

test('updateMemory 敏感信息失败回滚：原记忆不变', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: '正常' });
  assert.throws(() => updateMemory(doc, m.id, { summary: '密码 123456' }), (e) => e.code === 'SENSITIVE_CONTENT');
  assert.equal(getMemory(doc, m.id).summary, '正常');
});

test('多用户隔离 + 多助手隔离', () => {
  const a = mkDoc(), b = mkDoc();
  createMemory(a, { summary: 'A 的记忆' });
  assert.equal(getMemories(b).length, 0); // 用户隔离

  const doc = mkDoc();
  doc.ai.memories = [
    { id: 'u', category: 'profile', summary: '用户级', assistantId: null },
    { id: 'act', category: 'profile', summary: '激活助手', assistantId: 'a2' },
    { id: 'other', category: 'profile', summary: '其他助手', assistantId: 'zzz' },
  ];
  const { memories } = buildMemoryContext(doc, {});
  assert.ok(!memories.some((m) => m.id === 'other')); // 助手隔离
});

test('候选与正式记忆都绝不绑定 assistants[0]', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { summary: 'x', assistantId: 'a1' });
  assert.equal(c.assistantId, null);
  const m = createMemory(doc, { summary: 'y', assistantId: 'a1' });
  assert.equal(m.assistantId, null);
  const m2 = createMemory(doc, { summary: 'z', assistantId: 'a2' });
  assert.equal(m2.assistantId, 'a2'); // 激活助手可绑定
});

test('saveUserStateIfVersion 版本冲突返回 false；withDoc 并发写不覆盖（合并重试）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { version: 1, ai: { memories: [] } } });
  const id = user.id;
  assert.equal(await saveUserStateIfVersion(id, { version: 2, ai: { memories: [] } }, 1), true);
  assert.equal(await saveUserStateIfVersion(id, { version: 3, ai: { memories: [] } }, 1), false); // 版本已变

  const u2 = await createUser({ email: null, passwordHash: null, state: { version: 1, ai: { memories: [] } } });
  await withDoc(u2.id, (doc) => { doc.ai.memories.push({ id: 'm1', summary: 'A' }); return 'a'; });
  await withDoc(u2.id, (doc) => { doc.ai.memories.push({ id: 'm2', summary: 'B' }); return 'b'; });
  const state = await getState(u2.id);
  assert.equal(state.ai.memories.length, 2); // 两次写都保留，未互相覆盖
  assert.ok(state.version >= 3);
});
