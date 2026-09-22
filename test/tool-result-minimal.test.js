// 回归测试：工具结果「最小必要」原则 + 工具执行后最终回复不跑题。
// 覆盖：工具总数=90、写工具最小返回（不回灌完整对象）、读工具保留必要数据、读工具 limit 仍有效、
//       Tool Loop 原始消息保留（A）、nudge 语义（E）、RULES_PREAMBLE 语义、Anthropic/OpenAI 双协议结构（F/G）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools, CORE_ALWAYS_TOOLS, readJournalEntries } from '../lib/tools.js';
import { buildSystemInstructions } from '../lib/context-builder.js';
import { createSession } from '../lib/db.js';

// node --test 每个测试文件独立进程，安全地改写 config 与 global.fetch。
config.mock = false;
config.anthropicApiKey = 'test-anthropic-key';
config.anthropicBaseUrl = 'http://test-anthropic.local';
config.anthropicProtocol = 'anthropic';
config.deepseekApiKey = 'test-deepseek-key';
config.deepseekBaseUrl = 'http://test-deepseek.local';

const origFetch = global.fetch;
after(() => { global.fetch = origFetch; });

function jsonResponse(json) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => json,
  };
}

// 每次调用记录请求体，按顺序返回 turns 里的响应（最后一轮重复使用最后一个）。
function fetchStub(turns) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const t = turns[Math.min(calls.length - 1, turns.length - 1)];
    return jsonResponse(t);
  };
  return calls;
}

// ---------- 1. 工具总数与核心工具集 ----------

test('工具总数 = 90，核心常驻工具 = 9（数量不得被本次改动增减）', () => {
  const { names } = buildDomainTools('x', 'test-model');
  assert.equal(names.length, 90);
  assert.equal(new Set(names).size, 90, '无重名工具');
  assert.equal(CORE_ALWAYS_TOOLS.length, 9);
});

// ---------- 2. 写工具最小返回：不回灌完整对象（数据仍真实落库） ----------

test('写工具最小返回：只回传 code，不回灌完整 task/item/state/activity（数据仍真实落库）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model', { sessionId: 'sess-min' });

  const t = JSON.parse(await callTool('create_task', { title: '写工具最小', reason: '回归' }));
  assert.equal(t.code, 'CREATED');
  assert.equal(t.task, undefined, 'create_task 不回灌完整 task 对象');

  const it = JSON.parse(await callTool('add_shopping_item', { title: '牛奶', listId: 'mine' }));
  assert.equal(it.code, 'CREATED');
  assert.equal(it.item, undefined, 'add_shopping_item 不回灌完整 item 对象');

  const st = JSON.parse(await callTool('set_ai_state', { emotion: '平静', intensity: 3 }));
  assert.equal(st.code, 'CREATED');
  assert.equal(st.state, undefined, 'set_ai_state 不回灌完整 state 对象（AI 自我叙述）');

  const act = JSON.parse(await callTool('create_ai_activity', { content: '今天天气不错。' }));
  assert.equal(act.code, 'CREATED');
  assert.equal(act.activity, undefined, 'create_ai_activity 不回灌完整 activity 对象（AI 自我叙述）');

  // 最小返回 ≠ 不写库：数据必须真实落库
  const state = await getState(user.id);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.shoppingItems.length, 1);
  assert.equal(state.ai.states.length, 1);
  assert.equal(state.ai.activities.length, 1);
});

test('写工具最小返回：complete_task/complete_shopping_item 只回传 completed 标量', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: {
      tasks: [{ id: 't1', title: 'x', completed: false, createdAt: 1, updatedAt: 1 }],
      shoppingItems: [{ id: 'i1', title: 'y', listId: 'mine', owner: 'user', completed: false, createdAt: 1, updatedAt: 1 }],
    },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');

  const t = JSON.parse(await callTool('complete_task', { id: 't1', completed: true }));
  assert.equal(t.code, 'OK');
  assert.equal(t.completed, true);
  assert.equal(t.task, undefined);

  const i = JSON.parse(await callTool('complete_shopping_item', { id: 'i1', completed: true }));
  assert.equal(i.code, 'OK');
  assert.equal(i.completed, true);
  assert.equal(i.item, undefined);
});

test('写工具最小返回：comment_on_record / save_conversation_cache 不回灌 AI 自我叙述', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { journal: [{ id: 'j1', date: '2026-09-18', content: '今天散步' }] },
  });
  const s = await createSession('cache-min');
  const { callTool } = buildDomainTools(user.id, 'test-model', { sessionId: s.id });

  const c = JSON.parse(await callTool('comment_on_record', { recordType: 'journal', recordId: 'j1', comment: '散步很棒。' }));
  assert.equal(c.code, 'CREATED');
  assert.equal(c.recordId, 'j1');
  assert.equal(c.comment, undefined, 'comment_on_record 不回灌 comment 全文');

  const cache = JSON.parse(await callTool('save_conversation_cache', { summary: 'x', currentTopic: 'y' }));
  assert.equal(cache.code, 'OK');
  assert.equal(cache.cache, undefined, 'save_conversation_cache 不回灌整份 cache');
});

// ---------- 3. 读工具保留必要数据 ----------

test('读工具保留必要数据：get_expenses 保留金额，get_journal 保留正文', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: {
      expenses: [{ id: 'e1', title: '午饭', amountCents: 2500, kind: 'expense', occurredAt: '2026-09-18', category: '吃饭' }],
      journal: [{ id: 'j1', date: '2026-09-18', content: '今天好累' }],
    },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');

  const e = JSON.parse(await callTool('get_expenses', {}));
  assert.equal(e.code, 'OK');
  assert.equal(e.expenses[0].amountCents, 2500, '金额是回答财务问题的必要数据，必须保留');

  const j = JSON.parse(await callTool('get_journal', {}));
  assert.equal(j.code, 'OK');
  assert.equal(j.journal[0].content, '今天好累', '日志正文是回答用户问题的必要数据，必须保留');
});

// ---------- 4. 读工具 limit 仍有效 ----------

test('readJournalEntries：条目上限 10 / 单条 500 字符 / 总量 3000 字符（最小化不破坏限制）', () => {
  // 条目数上限 10
  const many = { journal: Array.from({ length: 15 }, (_, i) => ({ id: 'j' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), content: '短' + i })) };
  assert.equal(readJournalEntries(many, { mode: 'recent', limit: 100 }).journal.length, 10);

  // 单条 500 字符截断
  const oneLong = { journal: [{ id: 'j', date: '2026-09-18', content: 'x'.repeat(600) }] };
  const r1 = readJournalEntries(oneLong, { mode: 'recent' });
  assert.equal(r1.journal[0].content.length, 500);
  assert.equal(r1.journal[0].truncated, true);

  // 总量 3000 字符
  const totalCap = { journal: Array.from({ length: 20 }, (_, i) => ({ id: 'j' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), content: 'y'.repeat(500) })) };
  const r2 = readJournalEntries(totalCap, { mode: 'recent', limit: 100 });
  const total = r2.journal.reduce((s, j) => s + j.content.length, 0);
  assert.ok(total <= 3000);
  assert.ok(r2.journal.length <= 10);
});

// ---------- 5. A：Tool Loop 原始消息保留 ----------

test('A：工具循环后，原始用户消息仍保留在上下文中（不被工具结果覆盖）', async () => {
  const calls = fetchStub([
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_task', arguments: '{"title":"测试"}' } }] } }], usage: {} },
    { choices: [{ message: { role: 'assistant', content: '好的。' } }], usage: {} },
  ]);
  const reply = await chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '帮我记一件重要的事：明天开会。' }],
    tools: [{ name: 'create_task', description: '', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
    callTool: async () => JSON.stringify({ code: 'CREATED' }),
  });
  assert.equal(reply.content, '好的。');
  // 第二轮请求仍以原始用户消息开头（工具结果只追加，绝不覆盖/丢弃原始消息）
  const req2 = calls[1];
  assert.equal(req2.messages[0].role, 'user');
  assert.equal(req2.messages[0].content, '帮我记一件重要的事：明天开会。');
});

// ---------- 6. E：nudge 语义 ----------

test('E：nudge 语义——工具跑完强制继续，优先回应用户原始消息、不要求汇报工具', async () => {
  const calls = fetchStub([
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_ai_state', arguments: '{"emotion":"认真"}' } }] } }], usage: {} },
    { choices: [{ message: { role: 'assistant', content: '' } }], usage: {} }, // 工具跑完但没给最终文字
    { choices: [{ message: { role: 'assistant', content: '好，我记下心情了。' } }], usage: {} },
  ]);
  const reply = await chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '记一下心情' }],
    tools: [{ name: 'set_ai_state', description: '', parameters: { type: 'object', properties: { emotion: { type: 'string' } } } }],
    callTool: async () => JSON.stringify({ code: 'CREATED' }),
  });
  assert.equal(reply.content, '好，我记下心情了。');
  // 第三轮请求的最后一条消息 = 注入的 nudge 提示（语义正确，不要求汇报工具）
  const req3 = calls[2];
  const nudge = req3.messages[req3.messages.length - 1].content;
  assert.ok(nudge.includes('优先回应'), 'nudge 应引导优先回应用户');
  assert.ok(nudge.includes('内部'), 'nudge 应声明工具调用是内部执行过程');
  assert.ok(!nudge.includes('把你刚才完成的事告诉用户'), 'nudge 不得再要求「汇报刚才完成的事」');
  assert.ok(!nudge.includes('已改好'), 'nudge 不得再绑定「已改好」汇报话术');
});

// ---------- 7. RULES_PREAMBLE 语义 ----------

test('RULES_PREAMBLE：不再要求「告知用户已改好」，改为内部执行 + 优先回应', () => {
  const { text } = buildSystemInstructions({}, 100000);
  assert.ok(text.includes('内部执行过程'));
  assert.ok(text.includes('优先回应'));
  assert.ok(!text.includes('才可告知用户'), '移除「仅当 code=… 才可告知用户已改好」的汇报要求');
});

// ---------- 8. F/G：Anthropic / OpenAI 双协议结构 ----------

test('F/G：最小 tool_result 正确流经 Anthropic 与 OpenAI 两种协议（不夹带完整对象）', async () => {
  // OpenAI 兼容协议：tool_result 是 role=tool 消息，content 只含 code
  const callsO = fetchStub([
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_task', arguments: '{"title":"x"}' } }] } }], usage: {} },
    { choices: [{ message: { role: 'assistant', content: '好了。' } }], usage: {} },
  ]);
  await chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '建任务' }],
    tools: [{ name: 'create_task', description: '', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
    callTool: async () => JSON.stringify({ code: 'CREATED' }),
  });
  const oTool = callsO[1].messages.find((m) => m.role === 'tool');
  assert.ok(oTool, 'OpenAI 协议应有 tool 消息');
  assert.equal(oTool.content, '{"code":"CREATED"}', '只回传 code，无完整 task 对象');

  // Anthropic 原生协议：tool_result 内容只含 code
  const callsA = fetchStub([
    { content: [{ type: 'tool_use', id: 'ta1', name: 'create_task', input: { title: 'x' } }], usage: {} },
    { content: [{ type: 'text', text: '好了。' }], usage: {} },
  ]);
  await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '建任务' }],
    tools: [{ name: 'create_task', description: '', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
    callTool: async () => JSON.stringify({ code: 'CREATED' }),
  });
  const aLast = callsA[1].messages[callsA[1].messages.length - 1];
  assert.equal(aLast.role, 'user');
  assert.equal(aLast.content[0].type, 'tool_result');
  assert.equal(aLast.content[0].content, '{"code":"CREATED"}', '只回传 code，无完整 task 对象');
});
