import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PERMISSION_POLICY, aiCan, TOOL_ACTIONS } from '../lib/permissions.js';
import { createUser } from '../lib/store.js';
import { getState, defaultState, upsertAiComment } from '../lib/domain.js';
import { buildDomainTools, CORE_ALWAYS_TOOLS, TOOL_DOMAIN_MAP, toolsForDomains } from '../lib/tools.js';
import { estimateTokens } from '../lib/tokens.js';
import { buildAIContext } from '../lib/context-builder.js';
import { createSession, createMessage } from '../lib/db.js';
import { chat, providerForModel, resolveAssistantModel, supportsToolCalling } from '../lib/ai.js';
import { config } from '../lib/config.js';

const commentDef = () => buildDomainTools('x', 'test-model').tools.find((t) => t.name === 'comment_on_record');

// ---- 1. 工具注册：单一工具，schema 含 recordType enum + required ----
test('comment_on_record 已注册，schema 含 recordType enum 与 recordId/comment 必填', () => {
  const def = commentDef();
  assert.ok(def, 'comment_on_record 工具存在');
  assert.equal(def.parameters.type, 'object');
  assert.equal(def.parameters.properties.recordType.enum.join(','), 'journal,health,finance');
  assert.deepEqual(def.parameters.required, ['recordType', 'recordId', 'comment']);
  // 绝不暴露 userId / Bark 等敏感字段
  assert.ok(!('userId' in def.parameters.properties));
});

// ---- 2. 执行：create → CREATED，且只落一条评论 ----
test('comment_on_record：首次评论返回 CREATED，评论落在 doc.ai.comments', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { journal: [{ id: 'j1', date: '2026-09-18', time: '21:00', mood: '开心', content: '今天和年糕一起散步了。' }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '散步很棒，记得喝水哦。' }));
  assert.equal(r.code, 'CREATED');
  assert.equal(r.recordId, 'j1');
  assert.equal(r.comment.recordType, 'journal');

  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 1);
  assert.equal(state.ai.comments[0].text, '散步很棒，记得喝水哦。');
  assert.equal(state.ai.comments[0].actor, 'assistant');
  assert.equal(state.ai.comments[0].version, 1);
});

// ---- 3. 重复评论 = 覆盖更新（同 id，version+1，仍只一条） ----
test('comment_on_record：重复评论覆盖更新，version+1，仅保留一条', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { health: [{ id: 'h1', date: '2026-09-18', sleep: 7, water: 1.5, caloriesIn: 1800, caloriesOut: 300, weight: 55 }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const a = JSON.parse(await callTool('comment_on_record', { recordType: 'health', recordId: 'h1', comment: '睡眠不错。' }));
  const b = JSON.parse(await callTool('comment_on_record', { recordType: 'health', recordId: 'h1', comment: '睡眠不错，继续保持。' }));
  assert.equal(a.code, 'CREATED');
  assert.equal(b.code, 'UPDATED');
  assert.equal(a.comment.id, b.comment.id, '更新后 id 不变');
  assert.equal(b.comment.version, 2);

  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 1, '同 (recordType,recordId) 只保留一条');
  assert.equal(state.ai.comments[0].text, '睡眠不错，继续保持。');
});

// ---- 4. 权限：COMMENT 与 WRITE 分离；无 ADMIN ----
test('权限：journal 可评论但 write 仍为 false；ai_comment 实体存在；无 admin', () => {
  assert.equal(aiCan('journal', 'comment'), true);
  assert.equal(aiCan('journal', 'write'), false, '评论权限绝不连带 WRITE');
  assert.equal(aiCan('health', 'comment'), true);
  assert.equal(aiCan('finance', 'comment'), true);
  assert.equal(aiCan('health', 'write'), true, 'health 原有 write 权限不变');
  assert.equal(aiCan('finance', 'write'), true, 'finance 原有 write 权限不变');
  assert.equal(aiCan('signature', 'comment'), false, '签名不可评论');
  assert.ok(AI_PERMISSION_POLICY.ai_comment);
  assert.equal(aiCan('ai_comment', 'create'), true);
  assert.equal(aiCan('ai_comment', 'delete'), false);
  assert.equal('admin' in AI_PERMISSION_POLICY, false);
  assert.equal(TOOL_ACTIONS.comment_on_record.entity, 'ai_comment');
});

// ---- 5. 校验/安全：非法类型 / 记录不存在 / 空评论 ----
test('comment_on_record：非法 recordType → INVALID；记录不存在 → NOT_FOUND；空评论 → FAILED', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'j1', content: 'x' }] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  assert.equal(JSON.parse(await callTool('comment_on_record', { recordType: 'notes', recordId: 'j1', comment: 'hi' })).code, 'INVALID');
  assert.equal(JSON.parse(await callTool('comment_on_record', { recordType: 'journal', recordId: 'nope', comment: 'hi' })).code, 'NOT_FOUND');
  assert.equal(JSON.parse(await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '   ' })).code, 'FAILED');
});

// ---- 5b. 财务：recordId 同时支持 expenses 与 purchases ----
test('comment_on_record：finance 可评论 expense 与 purchase', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: {
      expenses: [{ id: 'e1', title: '麻辣烫', category: '吃饭', amountCents: 2000, kind: 'expense', occurredAt: '2026-09-18' }],
      purchases: [{ id: 'p1', itemName: '雨伞', quantity: 1, unitPriceCents: 3800, totalAmountCents: 3800, category: '生活用品' }],
    },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const e = JSON.parse(await callTool('comment_on_record', { recordType: 'finance', recordId: 'e1', comment: '这顿吃得值。' }));
  const p = JSON.parse(await callTool('comment_on_record', { recordType: 'finance', recordId: 'p1', comment: '雨天有伞真好。' }));
  assert.equal(e.code, 'CREATED');
  assert.equal(p.code, 'CREATED');
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 2);
});

// ---- 6. 审计：create/update 均落 entityType=ai_comment 且含 recordType/recordId/actor ----
test('审计：create/update 各落一条 ai_comment 审计（recordType/recordId/before/after/actor）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'j1', content: '今天下雨。' }] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '注意带伞。' });
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '记得带伞，别淋雨。' });

  const state = await getState(user.id);
  const logs = state.ai.auditLog.filter((a) => a.entityType === 'ai_comment');
  assert.equal(logs.length, 2);
  const [latest, first] = logs;
  assert.equal(latest.action, 'comment');
  assert.equal(latest.aiAction, 'comment_on_record');
  assert.equal(latest.recordType, 'journal');
  assert.equal(latest.recordId, 'j1');
  assert.equal(latest.actor, 'assistant');
  assert.equal(latest.before, '注意带伞。', 'update 的 before 是旧评论');
  assert.equal(latest.after, '记得带伞，别淋雨。');
  assert.equal(first.before, null, 'create 的 before 为 null');
});

// ---- 7. 隔离：评论绝不写 AI 动态 / 记忆 / 心情 ----
test('隔离：评论不产生 AI Activity / Memory / Mood 副作用', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'j1', content: 'x' }] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '有进步。' });
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 1);
  assert.equal(state.ai.activities.length, 0, '评论不是 AI 动态');
  assert.equal(state.ai.memories.length, 0, '评论不是长期记忆');
  assert.equal(state.ai.states.length, 0, '评论不设置 AI 心情');
});

// ---- 8. 原始记录不变：评论绝不改用户记录 ----
test('原始记录不变：评论后 journal/health/expense 字段完全一致', async () => {
  const journal = { id: 'j1', date: '2026-09-18', time: '10:00', mood: '平静', content: '原文不改。', tags: ['t1'] };
  const health = { id: 'h1', date: '2026-09-18', sleep: 8, water: 2, caloriesIn: 2000, caloriesOut: 500, weight: 60 };
  const expense = { id: 'e1', title: '午饭', category: '吃饭', amountCents: 2500, kind: 'expense', occurredAt: '2026-09-18', note: 'n' };
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [journal], health: [health], expenses: [expense] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: 'c1' });
  await callTool('comment_on_record', { recordType: 'health', recordId: 'h1', comment: 'c2' });
  await callTool('comment_on_record', { recordType: 'finance', recordId: 'e1', comment: 'c3' });

  const state = await getState(user.id);
  assert.deepEqual(state.journal[0], journal);
  assert.deepEqual(state.health[0], health);
  assert.deepEqual(state.expenses[0], expense);
});

// ---- 9. Token 优化：不进 CORE_ALWAYS_TOOLS，只按领域注入 ----
test('Token 优化：comment_on_record 不进核心，只随 journal/health/finance 注入；schema 成本>0', () => {
  assert.ok(!CORE_ALWAYS_TOOLS.includes('comment_on_record'));
  assert.deepEqual(TOOL_DOMAIN_MAP.comment_on_record, ['journal', 'health', 'finance']);

  assert.ok(toolsForDomains(['journal']).some((t) => t.name === 'comment_on_record'));
  assert.ok(toolsForDomains(['health']).some((t) => t.name === 'comment_on_record'));
  assert.ok(toolsForDomains(['finance']).some((t) => t.name === 'comment_on_record'));
  assert.ok(!toolsForDomains([]).some((t) => t.name === 'comment_on_record'), '普通聊天不注入');
  assert.ok(!toolsForDomains(['shopping']).some((t) => t.name === 'comment_on_record'));

  const def = commentDef();
  assert.ok(estimateTokens(JSON.stringify([def])) > 0, '工具 schema 计入 token 成本');
});

// ---- 10. 引用到聊天：quotedRecord 注入上下文 ----
test('引用到聊天：quotedRecord 注入 buildAIContext 的 system 文本', async () => {
  const s = await createSession('引用评论');
  await createMessage(s.id, { role: 'user', content: '聊一下这条' });
  const built = await buildAIContext({
    sessionId: s.id, doc: defaultState(), settings: {},
    content: '聊一下这条', model: 'deepseek-chat', tools: [],
    quotedRecord: { type: 'record_comment', recordType: 'journal', recordId: 'j1', recordContent: '今天散步。', aiComment: '散步很好。', createdAt: 1 },
  });
  assert.ok(built.system.includes('记录内容：今天散步。'), '注入记录内容');
  assert.ok(built.system.includes('祂的评论：散步很好。'), '注入评论正文');
});

// ---- 11. 领域 helper 单元：upsertAiComment create/update ----
test('upsertAiComment：create 后 update 覆盖、version 递增、id 不变', () => {
  const doc = defaultState();
  const a = upsertAiComment(doc, { recordType: 'journal', recordId: 'j1', text: '第一句' });
  assert.equal(a.action, 'create');
  const b = upsertAiComment(doc, { recordType: 'journal', recordId: 'j1', text: '第二句' });
  assert.equal(b.action, 'update');
  assert.equal(b.comment.id, a.comment.id);
  assert.equal(b.comment.version, 2);
  assert.equal(doc.ai.comments.length, 1);
  assert.equal(doc.ai.comments[0].text, '第二句');
});

// ---- 12. 多条日志不串绑：每条日志按 (recordType, recordId) 绑定自己的评论 ----
test('多条日志评论不串绑：每条日志绑定自己的评论', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {
    journal: [
      { id: 'j1', date: '2026-09-18', time: '09:00', content: '第一条日志' },
      { id: 'j2', date: '2026-09-18', time: '10:00', content: '第二条日志' },
    ],
  } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '评论一' });
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'j2', comment: '评论二' });
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 2, '两条日志各一条评论');
  const byId = (id) => state.ai.comments.find((c) => c.recordType === 'journal' && c.recordId === id);
  assert.equal(byId('j1').text, '评论一', 'j1 的评论不会被串到 j2');
  assert.equal(byId('j2').text, '评论二');
  assert.notEqual(byId('j1').id, byId('j2').id, '两条评论是独立条目');
});

// ---- 13. 多条健康记录不串绑 ----
test('多条健康记录评论不串绑：每条健康记录绑定自己的评论', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {
    health: [
      { id: 'h1', date: '2026-09-17', sleep: 6, water: 1, caloriesIn: 1600, caloriesOut: 200, weight: 55 },
      { id: 'h2', date: '2026-09-18', sleep: 8, water: 2, caloriesIn: 2000, caloriesOut: 500, weight: 55 },
    ],
  } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('comment_on_record', { recordType: 'health', recordId: 'h1', comment: '昨天睡得少了点' });
  await callTool('comment_on_record', { recordType: 'health', recordId: 'h2', comment: '今天睡得很好' });
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 2);
  const byId = (id) => state.ai.comments.find((c) => c.recordType === 'health' && c.recordId === id);
  assert.equal(byId('h1').text, '昨天睡得少了点', 'h1 的评论不会被串到 h2');
  assert.equal(byId('h2').text, '今天睡得很好');
});

// ---- 14. 缺 Key 诚实降级：chat() 抛「缺少 … API Key」，绝不返回假评论 ----
// 仅当测试环境未配置任何 provider key / 非 mock 时运行；有 key 时跳过（否则会真发网络请求）。
test('no_key：未配置 provider key 时 chat() 抛「缺少 … API Key」', { skip: Boolean(config.mock || config.deepseekApiKey || config.openaiApiKey || config.anthropicApiKey) }, async () => {
  await assert.rejects(
    () => chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }),
    /API Key/,
  );
});

// ---- 15. mock 模式：chat() 返回无 toolEvents，commented 恒为 false（绝不假装跑过工具循环） ----
test('mock 模式：chat() 返回无 toolEvents（不产生评论）', async () => {
  const prev = config.mock;
  config.mock = true;
  try {
    const r = await chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], tools: [], callTool: null });
    assert.ok(!r.toolEvents, 'mock 模式没有 toolEvents，commented 恒为 false');
  } finally {
    config.mock = prev;
  }
});

// ---- 16-20. 助手 Runtime 复用：评论使用「用户当前助手」，绝不硬编码 DeepSeek ----

// A/B：评论模型解析跟随激活助手（Claude→anthropic / GPT→openai），绝不 fallback deepseek
test('A/B：评论模型解析跟随激活助手（Claude→anthropic / GPT→openai），绝不 fallback deepseek', () => {
  const doc = { activeAssistantId: 'a2', aiSettings: { model: 'deepseek-chat' }, assistants: [{ id: 'a1', model: 'deepseek-chat' }, { id: 'a2', model: 'claude-sonnet-5' }] };
  assert.equal(resolveAssistantModel(doc), 'claude-sonnet-5');
  assert.equal(providerForModel(resolveAssistantModel(doc)), 'anthropic');
  assert.notEqual(providerForModel(resolveAssistantModel(doc)), 'deepseek', '绝不偷偷用 deepseek');

  const doc2 = { activeAssistantId: 'a2', assistants: [{ id: 'a1', model: 'deepseek-chat' }, { id: 'a2', model: 'gpt-4o' }] };
  assert.equal(providerForModel(resolveAssistantModel(doc2)), 'openai');
});

// C：助手=Claude 时 provider=anthropic，评论无需 DeepSeek Key
test('C：助手=Claude 时 provider=anthropic，评论无需 DeepSeek Key', () => {
  const doc = { activeAssistantId: 'c1', assistants: [{ id: 'c1', model: 'claude-opus-5' }] };
  const model = resolveAssistantModel(doc);
  assert.equal(model, 'claude-opus-5');
  assert.equal(providerForModel(model), 'anthropic');
  assert.notEqual(model, 'deepseek-chat', '模型绝不退回 deepseek，因此不会去要 DeepSeek Key');
});

// D：supportsToolCalling 只认工具可用模型族；未知模型诚实 false（不静默当 DeepSeek）
test('D：supportsToolCalling 只认工具可用模型族；未知模型诚实 false（不静默当 DeepSeek）', () => {
  assert.equal(supportsToolCalling('claude-sonnet-5'), true);
  assert.equal(supportsToolCalling('gpt-4o'), true);
  assert.equal(supportsToolCalling('deepseek-chat'), true);
  assert.equal(supportsToolCalling('qwen-max'), false, '未知模型 → unsupported_tool_call，绝不静默切 DeepSeek');
  assert.equal(supportsToolCalling(''), false);
});

// D：助手 tool loop 无 tool_calls → 不切换模型、不伪造评论
test('D：助手 tool loop 无 tool_calls → 不切换模型、不伪造评论', async () => {
  const prev = config.mock;
  config.mock = true; // mock 运行时不会产生任何 tool_calls（等价于「该助手不支持/未返回工具调用」）
  try {
    const { tools, callTool } = buildDomainTools('x', 'claude-sonnet-5');
    const slim = tools.filter((t) => t.name === 'comment_on_record');
    const r = await chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: '记录内容：今天散步了。' }], tools: slim, callTool });
    assert.ok(!r.toolEvents || r.toolEvents.length === 0, '无 tool 调用 → commented=false');
    assert.equal(providerForModel('claude-sonnet-5'), 'anthropic', '模型仍是 Claude，绝不切 DeepSeek');
  } finally {
    config.mock = prev;
  }
});

// E：评论真实执行后，读回 doc.ai.comments 可确认 persisted=true
test('E：评论真实执行后，读回 doc.ai.comments 可确认 persisted=true', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'j1', date: '2026-09-18', content: '今天和年糕散步。' }] } });
  const { callTool } = buildDomainTools(user.id, 'claude-sonnet-5');
  const r = JSON.parse(await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '散步真好，记得喝水。' }));
  assert.equal(r.code, 'CREATED');
  const latest = await getState(user.id);
  const persisted = !!(latest.ai && Array.isArray(latest.ai.comments) && latest.ai.comments.some((c) => c.recordType === 'journal' && c.recordId === 'j1'));
  assert.equal(persisted, true, '评论已落库并可从 state 读回');
});
