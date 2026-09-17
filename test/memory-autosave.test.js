import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memorySettings, autoSaveEnabled,
  getMemories, getPendingCandidates, buildMemoryContext, createMemory,
  addCandidate, confirmCandidate, cleanupExpiredCandidates,
  shouldRemember, decideMemoryAction, proposeMemory,
  CANDIDATE_LIMITS,
} from '../services/memory-service.js';
import { getState } from '../lib/domain.js';
import { createUser } from '../lib/store.js';
import { buildDomainTools } from '../lib/tools.js';

// 最小文档。autoSaveOff() 用于所有 autoSaveEnabled=false 场景。
function mkDoc(overrides = {}) {
  return {
    assistants: [{ id: 'a1', name: '一号' }, { id: 'a2', name: '二号' }],
    activeAssistantId: 'a2',
    ai: { memories: [], memoryCandidates: [], memorySignals: [] },
    memorySettings: { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' },
    ...overrides,
  };
}
const autoSaveOff = () => mkDoc({ memorySettings: { enabled: true, autoSaveEnabled: false, confirmationMode: 'ask_before_save' } });

// ---- 场景 1：自动推断被关闭 ----
test('autoSaveEnabled=false：AI 推断的普通偏好 → ignore，不创建正式记忆/候选，不进上下文', () => {
  const doc = autoSaveOff();
  assert.equal(memorySettings(doc).autoSaveEnabled, false);
  assert.equal(autoSaveEnabled(doc), false);

  const r = proposeMemory(doc, { category: 'preference', summary: '我喜欢安静音乐', source: 'ai_extracted' });
  assert.equal(r.action, 'ignore');
  assert.equal(r.reason, 'auto_save_disabled');

  assert.equal(getMemories(doc).length, 0);        // 不直接创建正式 Memory
  assert.equal(getPendingCandidates(doc).length, 0); // 当前设计不生成候选
  assert.equal(buildMemoryContext(doc, {}).text, ''); // 不进正式 context
});

// ---- 场景 2：用户明确要求保存 ----
test('autoSaveEnabled=false：用户明确要求（source=user_explicit）仍保存正式记忆，字段正确、进上下文', () => {
  const doc = autoSaveOff();
  const r = proposeMemory(doc, { category: 'preference', key: 'music_taste', summary: '我喜欢安静的音乐', source: 'user_explicit' });
  assert.equal(r.action, 'save');
  assert.equal(r.memory.source, 'user_explicit');
  assert.equal(r.memory.userConfirmed, true);
  assert.equal(getMemories(doc).length, 1);
  assert.ok(buildMemoryContext(doc, {}).text.includes('我喜欢安静的音乐')); // 可进正式 context
});

test('autoSaveEnabled=false：userConfirmed=true 等价显式，仍保存', () => {
  const doc = autoSaveOff();
  const r = proposeMemory(doc, { category: 'preference', summary: '我喜欢安静的音乐', source: 'ai_extracted', userConfirmed: true });
  assert.equal(r.action, 'save');
  assert.equal(r.memory.userConfirmed, true);
});

// ---- 场景 3：未确认的 AI 推断不能转正 ----
test('autoSaveEnabled=false：AI 推测「可能喜欢简短回答」不转正、不影响已有记忆、不进上下文', () => {
  const doc = autoSaveOff();
  createMemory(doc, { category: 'preference', summary: '已有正式记忆' });
  const before = getMemories(doc).length;

  const r = proposeMemory(doc, { category: 'preference', summary: '用户可能喜欢简短回答', source: 'ai_extracted' });
  assert.equal(r.action, 'ignore');
  assert.equal(getMemories(doc).length, before); // 不影响已有正式记忆
  assert.equal(getPendingCandidates(doc).length, 0); // 不产生候选
  assert.equal(buildMemoryContext(doc, {}).text.includes('可能喜欢简短回答'), false); // 不进 context
});

test('addCandidate 同 summary 去重：不产生重复候选', () => {
  const doc = mkDoc();
  const c1 = addCandidate(doc, { category: 'preference', summary: '用户可能喜欢简短回答', source: 'ai_extracted' });
  const c2 = addCandidate(doc, { category: 'preference', summary: '用户可能喜欢简短回答', source: 'ai_extracted' });
  assert.equal(c1.id, c2.id); // 返回同一条，不新增
  assert.equal(getPendingCandidates(doc).length, 1);
});

test('addCandidate 数量上限：达到 maxPending 后返回 null，不无限累积', () => {
  const doc = mkDoc();
  for (let i = 0; i < CANDIDATE_LIMITS.maxPending; i++) {
    assert.ok(addCandidate(doc, { category: 'preference', summary: '候选 ' + i, source: 'ai_extracted' }));
  }
  assert.equal(getPendingCandidates(doc).length, CANDIDATE_LIMITS.maxPending);
  assert.equal(addCandidate(doc, { category: 'preference', summary: '溢出候选', source: 'ai_extracted' }), null);
});

test('candidate 过期清理仍有效：过期候选被 cleanupExpiredCandidates 移除', () => {
  const doc = mkDoc();
  const c = addCandidate(doc, { category: 'preference', summary: '会过期', source: 'ai_extracted' });
  c.expiresAt = Date.now() - 1;
  cleanupExpiredCandidates(doc);
  assert.equal(getPendingCandidates(doc).length, 0);
});

// ---- 场景 4：显式确认 candidate ----
test('confirmCandidate 在 autoSaveEnabled=false 下仍可转正（字段完整、候选标记 confirmed、进上下文）', () => {
  const doc = autoSaveOff();
  const c = addCandidate(doc, { category: 'preference', key: 'reply_style', summary: '用户喜欢简洁回答', source: 'ai_extracted' });
  const mem = confirmCandidate(doc, c.id);
  assert.equal(mem.userConfirmed, true);
  assert.equal(mem.summary, '用户喜欢简洁回答');
  assert.equal(getMemories(doc).length, 1);
  assert.equal(getPendingCandidates(doc).length, 0); // 从待确认移除
  assert.equal(c.status, 'confirmed');               // 标记 confirmed
  assert.ok(buildMemoryContext(doc, {}).text.includes('用户喜欢简洁回答')); // 可被正式 context 读取
});

// ---- 调用关系梳理：闸门到底在哪一层 ----
test('调用关系：shouldRemember/decideMemoryAction 不读 autoSaveEnabled，proposeMemory 才是自动保存闸门', () => {
  const doc = autoSaveOff();
  // shouldRemember 是纯文本判断，不看设置
  assert.equal(shouldRemember('我喜欢安静音乐').action, 'ask');
  assert.equal(shouldRemember('请记住我喜欢安静音乐').action, 'save');
  // decideMemoryAction 只看 confirmationMode，不看 autoSaveEnabled
  assert.equal(decideMemoryAction(doc, '我喜欢安静音乐').action, 'candidate');
  // 真正拦截 autoSaveEnabled=false 的是 proposeMemory
  assert.equal(proposeMemory(doc, { category: 'preference', summary: '我喜欢安静音乐', source: 'ai_extracted' }).reason, 'auto_save_disabled');
});

// ---- tools.save_memory 端到端 ----
test('tools.save_memory：autoSave=false 时非显式返回 AUTO_SAVE_DISABLED，显式返回 CREATED 并落库', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { memorySettings: { enabled: true, autoSaveEnabled: false, confirmationMode: 'ask_before_save' } },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');

  const auto = JSON.parse(await callTool('save_memory', { category: 'preference', summary: '我喜欢安静音乐', source: 'ai_extracted' }));
  assert.equal(auto.code, 'AUTO_SAVE_DISABLED');

  const explicit = JSON.parse(await callTool('save_memory', { category: 'preference', summary: '我喜欢安静的音乐', source: 'user_explicit' }));
  assert.equal(explicit.code, 'CREATED');

  const state = await getState(user.id);
  assert.equal(state.ai.memories.length, 1); // 仅显式那条落库
  assert.equal(state.ai.memories[0].source, 'user_explicit');
  assert.equal(state.ai.memories[0].userConfirmed, true);
});
