import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_CATEGORIES, CONFIRMATION_MODES, LIMITS,
  defaultMemorySettings, memorySettings, isEnabled, autoSaveEnabled,
  activeAssistantId, normalizeCategory, normalizeMemory,
  getMemories, activeMemories,
  detectSensitive, isSensitive,
  createMemory, upsertMemory, updateMemory, deleteMemory,
  deactivateMemory, restoreMemory, clearMemories, getMemory,
  listMemories, searchMemories, getRelevantMemories,
  buildMemoryContext, shouldRemember, detectMemoryConflict,
  mergeDuplicateMemories, upsertProfileMemory, upsertPreferenceMemory,
  saveImportantConversation,
} from '../services/memory-service.js';

// 最小文档：两个助手，激活的是第二个（不是 assistants[0]）
function mkDoc() {
  return {
    assistants: [
      { id: 'a1', name: '一号' },
      { id: 'a2', name: '二号' },
    ],
    activeAssistantId: 'a2',
    ai: { memories: [] },
    memorySettings: { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' },
  };
}

test('defaultMemorySettings 返回三字段默认值', () => {
  assert.deepEqual(defaultMemorySettings(), { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' });
});

test('memorySettings 兜底缺省 + 非法 confirmationMode 回退', () => {
  assert.equal(memorySettings({}).enabled, true);
  assert.equal(memorySettings({ memorySettings: { enabled: false } }).enabled, false);
  assert.equal(memorySettings({ memorySettings: { confirmationMode: 'bogus' } }).confirmationMode, 'ask_before_save');
  assert.equal(memorySettings({ memorySettings: { confirmationMode: 'explicit_only' } }).confirmationMode, 'explicit_only');
});

test('isEnabled / autoSaveEnabled 跟随设置', () => {
  assert.equal(isEnabled(mkDoc()), true);
  assert.equal(isEnabled({ memorySettings: { enabled: false } }), false);
  assert.equal(autoSaveEnabled({ memorySettings: { autoSaveEnabled: false } }), false);
});

test('activeAssistantId 取当前激活助手，绝不 fallback 到 assistants[0]', () => {
  const doc = mkDoc();
  assert.equal(activeAssistantId(doc), 'a2');
  assert.notEqual(activeAssistantId(doc), doc.assistants[0].id);
  assert.equal(activeAssistantId({}), null);
});

test('normalizeCategory 把枚举/自由文本归一化', () => {
  assert.equal(normalizeCategory('profile'), 'profile');
  assert.equal(normalizeCategory('偏好'), 'preference');
  assert.equal(normalizeCategory('重要对话'), 'important_conversation');
  assert.equal(normalizeCategory('功能配置'), 'functional_preference');
  assert.equal(normalizeCategory('任务'), 'task_context');
  assert.equal(normalizeCategory('随便什么'), 'preference');
});

test('normalizeMemory 把旧版 content/category 规整为结构化', () => {
  const m = normalizeMemory({ content: '喜欢简洁回答', category: '偏好', confidence: 0.5 });
  assert.equal(m.summary, '喜欢简洁回答');
  assert.equal(m.content, '喜欢简洁回答');
  assert.equal(m.category, 'preference');
  assert.equal(m.confidence, 0.5);
  assert.equal(m.isActive, true);
  assert.equal(normalizeMemory(null), null);
});

test('detectSensitive 识别密码/密钥/身份证/银行卡/cookie/token/Bark/精确位置', () => {
  for (const s of [
    '我的密码是 abc123', 'api_key: sk-abcdef123456', '身份证 110101199001011234',
    '银行卡号 6222021234567890123', '登录 cookie=sessionid123', 'access token xyz',
    'bark 推送 key 是 xxx', '精确位置 lat:39.9042 lng:116.4074',
  ]) {
    assert.notEqual(detectSensitive(s), null, '应识别敏感: ' + s);
  }
  assert.equal(detectSensitive('我喜欢喝咖啡'), null);
});

test('createMemory 创建结构化记忆', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { category: 'preference', summary: '喜欢简洁回答', importance: 'high' });
  assert.ok(m.id);
  assert.equal(m.summary, '喜欢简洁回答');
  assert.equal(m.content, '喜欢简洁回答');
  assert.equal(m.importance, 'high');
  assert.equal(m.isActive, true);
  assert.equal(doc.ai.memories.length, 1);
});

test('createMemory 拒绝敏感信息（HttpError SENSITIVE_CONTENT）', () => {
  const doc = mkDoc();
  assert.throws(() => createMemory(doc, { summary: '我的银行卡号 6222021234567890123' }), (e) => e.code === 'SENSITIVE_CONTENT');
  assert.equal(doc.ai.memories.length, 0);
});

test('createMemory 拒绝超长 value（VALUE_TOO_LARGE）', () => {
  const doc = mkDoc();
  assert.throws(() => createMemory(doc, { summary: '大 value', value: 'x'.repeat(LIMITS.maxValueChars + 1) }), (e) => e.code === 'VALUE_TOO_LARGE');
});

test('createMemory 超长 summary 被截断而非报错', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: 'y'.repeat(LIMITS.maxSummary + 100) });
  assert.equal(m.summary.length, LIMITS.maxSummary);
});

test('createMemory 数量达上限抛 MEMORY_LIMIT', () => {
  const doc = mkDoc();
  doc.ai.memories = Array.from({ length: LIMITS.maxMemories }, (_, i) => ({ id: 'm' + i, summary: 'x' }));
  assert.throws(() => createMemory(doc, { summary: '再来一条' }), (e) => e.code === 'MEMORY_LIMIT');
});

test('createMemory 绑定非激活助手（assistants[0]）被消毒为 null，绝不存 a1', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: 'x', assistantId: 'a1' }); // assistants[0]
  assert.equal(m.assistantId, null);
  // 绑定当前激活助手则保留
  const m2 = createMemory(doc, { summary: 'y', assistantId: 'a2' });
  assert.equal(m2.assistantId, 'a2');
});

test('upsertMemory 按 category+key 去重：同 key 更新而非新增', () => {
  const doc = mkDoc();
  upsertMemory(doc, { category: 'preference', key: 'reply_style', summary: '简洁', value: 'short' });
  upsertMemory(doc, { category: 'preference', key: 'reply_style', summary: '详细', value: 'long' });
  assert.equal(doc.ai.memories.length, 1);
  assert.equal(doc.ai.memories[0].summary, '详细');
  assert.equal(doc.ai.memories[0].value, 'long');
});

test('updateMemory 新值覆盖旧值（冲突：新值优先）', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { category: 'profile', key: 'name', summary: '旧称呼', value: '小明' });
  const updated = updateMemory(doc, m.id, { summary: '新称呼', value: '阿明' });
  assert.equal(updated.summary, '新称呼');
  assert.equal(updated.value, '阿明');
  assert.equal(doc.ai.memories.length, 1);
});

test('updateMemory 更新含敏感信息时拒绝', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: '正常' });
  assert.throws(() => updateMemory(doc, m.id, { summary: '密码是 123456' }), (e) => e.code === 'SENSITIVE_CONTENT');
});

test('updateMemory 不存在抛 NOT_FOUND', () => {
  assert.throws(() => updateMemory(mkDoc(), 'nope', { summary: 'x' }), (e) => e.code === 'NOT_FOUND');
});

test('deleteMemory 删除指定记忆', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: 'a' });
  assert.equal(deleteMemory(doc, m.id), true);
  assert.equal(deleteMemory(doc, m.id), false);
  assert.equal(doc.ai.memories.length, 0);
});

test('deactivateMemory / restoreMemory 停用与恢复', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: 'a' });
  assert.equal(deactivateMemory(doc, m.id).isActive, false);
  assert.equal(activeMemories(doc).length, 0);
  assert.equal(restoreMemory(doc, m.id).isActive, true);
  assert.equal(activeMemories(doc).length, 1);
});

test('clearMemories 清空全部', () => {
  const doc = mkDoc();
  createMemory(doc, { summary: 'a' });
  createMemory(doc, { summary: 'b' });
  assert.equal(clearMemories(doc), 2);
  assert.equal(doc.ai.memories.length, 0);
});

test('getMemory 按 id 取单条', () => {
  const doc = mkDoc();
  const m = createMemory(doc, { summary: 'x' });
  assert.equal(getMemory(doc, m.id).summary, 'x');
  assert.equal(getMemory(doc, 'none'), null);
});

test('listMemories 分类筛选 / 搜索 / 是否含停用', () => {
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', summary: '喜欢咖啡' });
  const m2 = createMemory(doc, { category: 'profile', summary: '我叫阿明' });
  deactivateMemory(doc, m2.id);
  assert.equal(listMemories(doc, { category: 'preference' }).length, 1);
  assert.equal(listMemories(doc, { query: '咖啡' }).length, 1);
  assert.equal(listMemories(doc, { includeInactive: false }).length, 1);
  assert.equal(listMemories(doc, { includeInactive: true }).length, 2);
});

test('searchMemories 含停用，返回上限内', () => {
  const doc = mkDoc();
  for (let i = 0; i < 30; i++) createMemory(doc, { summary: '偏好 ' + i });
  assert.equal(searchMemories(doc, '偏好', { limit: 5 }).length, 5);
});

test('getRelevantMemories 按助手作用域过滤：其他助手的记忆不可见', () => {
  const doc = mkDoc();
  doc.ai.memories = [
    { id: 'u1', category: 'preference', summary: '用户级', assistantId: null },
    { id: 'a2m', category: 'preference', summary: '激活助手', assistantId: 'a2' },
    { id: 'other', category: 'preference', summary: '别人的', assistantId: 'zzz' },
  ];
  const ids = getRelevantMemories(doc, { query: '' }).map((m) => m.id);
  assert.ok(ids.includes('u1'));
  assert.ok(ids.includes('a2m'));
  assert.ok(!ids.includes('other'));
});

test('getRelevantMemories 关键词相关排序靠前', () => {
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', summary: '无关内容' });
  const hit = createMemory(doc, { category: 'preference', summary: '我喜欢喝咖啡' });
  const top = getRelevantMemories(doc, { query: '咖啡' })[0];
  assert.equal(top.id, hit.id);
});

test('buildMemoryContext 功能关闭时返回空', () => {
  const doc = mkDoc();
  doc.memorySettings.enabled = false;
  createMemory(doc, { summary: 'x' });
  assert.deepEqual(buildMemoryContext(doc, {}), { text: '', memories: [] });
});

test('buildMemoryContext 过滤停用 + 过期，最多 10 条且受字符预算', () => {
  const doc = mkDoc();
  for (let i = 0; i < 50; i++) createMemory(doc, { category: 'preference', summary: '偏好咖啡口味 ' + i, key: 'k' + i });
  // 停用 + 过期各一条
  const inactive = createMemory(doc, { summary: '停用的' });
  deactivateMemory(doc, inactive.id);
  createMemory(doc, { summary: '过期的', expiresAt: Date.now() - 1000 });

  const { text, memories } = buildMemoryContext(doc, { query: '咖啡' });
  assert.ok(memories.length > 0);
  assert.ok(memories.length <= LIMITS.injectCount);
  assert.ok(!memories.some((m) => m.summary === '停用的'));
  assert.ok(!memories.some((m) => m.summary === '过期的'));
  assert.ok(text.startsWith('<user_memory>'));
  assert.ok(text.includes('不保证绝对正确'));
  assert.ok(text.length < LIMITS.injectChars + 2000, '注入文本受预算约束');
});

test('buildMemoryContext 用户级 + 激活助手可见，其他助手过滤', () => {
  const doc = mkDoc();
  doc.ai.memories = [
    { id: 'u', category: 'profile', summary: '用户级', assistantId: null },
    { id: 'a', category: 'profile', summary: '激活助手', assistantId: 'a2' },
    { id: 'z', category: 'profile', summary: '其他助手', assistantId: 'zzz' },
  ];
  const { memories } = buildMemoryContext(doc, {});
  assert.ok(!memories.some((m) => m.id === 'z'));
  assert.equal(memories.length, 2);
});

test('shouldRemember 明确请求→save，稳定偏好→ask，其余→ignore，敏感→ignore', () => {
  assert.equal(shouldRemember('记住我喜欢喝咖啡').action, 'save');
  assert.equal(shouldRemember('以后都叫我小兔').action, 'save');
  assert.equal(shouldRemember('我喜欢简洁回答').action, 'ask');
  assert.equal(shouldRemember('今天天气不错').action, 'ignore');
  assert.equal(shouldRemember('我的密码是 123').action, 'ignore');
  assert.equal(shouldRemember('').action, 'ignore');
});

test('detectMemoryConflict 返回同 category+key 的 active 记录', () => {
  const doc = mkDoc();
  createMemory(doc, { category: 'preference', key: 'reply_style', summary: '简洁' });
  const conflict = detectMemoryConflict(doc, { category: 'preference', key: 'reply_style' });
  assert.equal(conflict.summary, '简洁');
  assert.equal(detectMemoryConflict(doc, { category: 'preference', key: 'none' }), null);
  assert.equal(detectMemoryConflict(doc, { category: 'preference' }), null);
});

test('mergeDuplicateMemories 按 summary 去重，保留最新 active，其余停用', () => {
  const doc = mkDoc();
  createMemory(doc, { summary: '重复的' });
  createMemory(doc, { summary: '重复的' });
  createMemory(doc, { summary: '唯一的' });
  mergeDuplicateMemories(doc);
  const active = activeMemories(doc);
  assert.equal(active.filter((m) => m.summary === '重复的').length, 1);
  assert.equal(active.length, 2);
});

test('upsertProfileMemory 写 profile 类且 key 去重', () => {
  const doc = mkDoc();
  upsertProfileMemory(doc, 'name', '阿明');
  upsertProfileMemory(doc, 'name', '小明');
  assert.equal(doc.ai.memories.length, 1);
  assert.equal(doc.ai.memories[0].value, '小明');
  assert.equal(doc.ai.memories[0].category, 'profile');
});

test('upsertPreferenceMemory 写 preference 类，用户确认', () => {
  const doc = mkDoc();
  const m = upsertPreferenceMemory(doc, 'reply_style', '简洁', { source: 'user_explicit' });
  assert.equal(m.category, 'preference');
  assert.equal(m.userConfirmed, true);
});

test('saveImportantConversation 只存摘要，不存整段原文', () => {
  const doc = mkDoc();
  const m = saveImportantConversation(doc, {
    title: '关于项目的约定', summary: '用户希望每周三复盘', keyPoints: ['每周三复盘', '用邮件同步'],
  });
  assert.equal(m.category, 'important_conversation');
  assert.equal(m.summary, '用户希望每周三复盘');
  assert.equal(m.value.keyPoints.length, 2);
  // 原文不会以 content 形态存在（summary 即摘要）
  assert.equal(m.content, m.summary);
});

test('两个独立 doc 互不污染（按 userId 隔离的文档边界）', () => {
  const a = mkDoc();
  const b = mkDoc();
  createMemory(a, { summary: 'A 的记忆' });
  assert.equal(b.ai.memories.length, 0);
  assert.equal(getMemories(a).length, 1);
});
