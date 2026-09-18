// 回归测试：AI Activity 真实工具调用链（Bug 1 修复验证）。
// 覆盖：XML 剥离、Anthropic 原生 tool_use 循环、多工具、失败/DENIED 诚实回传、
//       普通聊天不触发工具、OpenAI 兼容协议回归、create_ai_activity 真实落库 + 审计 + 权限 + 领域检测。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chat, stripInternalXml, toAnthropicMessage, toAnthropicMessages } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';
import { aiCan } from '../lib/permissions.js';
import { detectDomains, TOOL_DOMAIN_SET } from '../lib/aiContext.js';

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

// ---------------------------------------------------------------- XML 剥离

test('stripInternalXml：剥离实际泄漏的 function_calls/invoke/parameter/thinking', () => {
  const leak = [
    '<function_calls>',
    '<invoke name="create_ai_activity">',
    '<parameter name="content">',
    "刚搬进 bunny's home。",
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    '<thinking>let me try to create an AI activity and see what happens.</thinking>',
  ].join('\n');
  const out = stripInternalXml('好的。\n' + leak + '\n我已经写好了。');
  assert.ok(out.includes('好的。'));
  assert.ok(out.includes('我已经写好了。'));
  for (const tag of ['function_calls', 'invoke', 'parameter', 'thinking', 'bunny']) {
    assert.ok(!out.includes(tag), `残留 ${tag}`);
  }
});

test('stripInternalXml：antml: 前缀与残留单标签兜底', () => {
  assert.equal(
    stripInternalXml('<antml:function_calls><antml:invoke name="x">a</antml:invoke></antml:function_calls>正文'),
    '正文'
  );
  // 不成对的残留标签（如流式截断）也被兜底规则清掉
  assert.equal(stripInternalXml('你好<thinking>'), '你好');
  assert.equal(stripInternalXml('<parameter name="x">'), '');
  assert.equal(stripInternalXml(''), '');
  assert.equal(stripInternalXml(null), '');
});

// ------------------------------------------------- 消息格式转换（Anthropic）

test('toAnthropicMessages：同一轮 assistant 的多个 tool 结果合并进同一条 user 消息', () => {
  const msgs = [
    { role: 'user', content: '创建两条动态' },
    {
      role: 'assistant', content: '好', toolCalls: [
        { id: 't1', name: 'create_ai_activity', input: { content: '测试1' } },
        { id: 't2', name: 'create_ai_activity', arguments: '{"content":"测试2"}' },
      ],
    },
    { role: 'tool', tool_call_id: 't1', content: '{"code":"CREATED"}' },
    { role: 'tool', tool_call_id: 't2', content: '{"code":"OK"}' },
  ];
  const out = toAnthropicMessages(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, '创建两条动态');
  // assistant 轮：text + 两个 tool_use；JSON 字符串 arguments 被解析为对象
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content[0].type, 'text');
  assert.equal(out[1].content[1].type, 'tool_use');
  assert.equal(out[1].content[1].id, 't1');
  assert.deepEqual(out[1].content[1].input, { content: '测试1' });
  assert.deepEqual(out[1].content[2].input, { content: '测试2' });
  // 合并：两个 tool_result 在同一条 user 消息
  const merged = out[2];
  assert.equal(merged.role, 'user');
  assert.equal(merged.content.length, 2);
  assert.deepEqual(merged.content.map((b) => b.tool_use_id), ['t1', 't2']);
  assert.equal(merged.content[0].content, '{"code":"CREATED"}');
});

test('toAnthropicMessages：不同 assistant 轮的 tool 结果分属各自的 user 消息', () => {
  const msgs = [
    { role: 'assistant', content: '好', toolCalls: [{ id: 't1', name: 'a', input: {} }] },
    { role: 'tool', tool_call_id: 't1', content: 'r1' },
    { role: 'assistant', content: '继续', toolCalls: [{ id: 't2', name: 'b', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 't2', content: 'r2' },
  ];
  const out = toAnthropicMessages(msgs);
  assert.equal(out.length, 4);
  assert.equal(out[1].role, 'user');
  assert.equal(out[1].content[0].tool_use_id, 't1');
  assert.equal(out[3].role, 'user');
  assert.equal(out[3].content[0].tool_use_id, 't2');
});

test('toAnthropicMessage：无 toolCalls 的普通消息保持纯字符串', () => {
  assert.equal(toAnthropicMessage({ role: 'user', content: '你好' }).content, '你好');
  assert.equal(toAnthropicMessage({ role: 'assistant', content: '' }).content, '');
});

// ------------------------------------------------ Anthropic 原生 tool_use 循环

test('Anthropic 原生 tool use：工具正式下发、执行、回传、最终自然语言回复', async () => {
  const calls = fetchStub([
    {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: 'let me try to create an AI activity and see what happens.' },
        { type: 'text', text: '我来写。' },
        { type: 'tool_use', id: 'toolu_1', name: 'create_ai_activity', input: { content: '测试 Activity' } },
      ],
      usage: { input_tokens: 10, output_tokens: 6 },
    },
    { id: 'msg_2', content: [{ type: 'text', text: '好，我已经把这条写进 AI Activity 了。' }], usage: { input_tokens: 15, output_tokens: 8 } },
  ]);

  const executed = [];
  const reply = await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '创建一条 AI Activity，内容是测试 Activity。' }],
    system: '你是 Bunny',
    tools: [{ name: 'create_ai_activity', description: '写入一条 AI 动态', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } }],
    callTool: async (name, args) => {
      executed.push({ name, args });
      return JSON.stringify({ code: 'CREATED', activity: { id: 'a1', type: 'chat', text: args.content } });
    },
  });

  assert.equal(reply.content, '好，我已经把这条写进 AI Activity 了。');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'create_ai_activity');
  assert.deepEqual(executed[0].args, { content: '测试 Activity' });

  // 第 1 轮：tools 以正式参数下发（含 input_schema），而非只写进提示词
  const req1 = calls[0];
  assert.equal(req1.tools.length, 1);
  assert.equal(req1.tools[0].name, 'create_ai_activity');
  assert.equal(req1.tools[0].input_schema.type, 'object');
  assert.equal(req1.tools[0].input_schema.properties.content.type, 'string');

  // 第 2 轮：tool_result 回传（同一条 user 消息），且不含 thinking 块
  const req2 = calls[1];
  const last = req2.messages[req2.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, 1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'toolu_1');
  assert.ok(String(last.content[0].content).includes('CREATED'));
  assert.equal(calls.length, 2);
});

test('Anthropic 一次回复多个 tool_use：全部执行，tool_result 合并在一条 user 消息', async () => {
  const calls = fetchStub([
    {
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_a', input: { x: 1 } },
        { type: 'tool_use', id: 't2', name: 'tool_b', input: { y: 2 } },
      ],
      usage: {},
    },
    { content: [{ type: 'text', text: '两件事都做完了。' }], usage: {} },
  ]);
  const names = [];
  const reply = await chat({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: '做两件事' }],
    tools: [
      { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } },
      { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } },
    ],
    callTool: async (name) => { names.push(name); return '{"code":"OK"}'; },
  });
  assert.deepEqual(names, ['tool_a', 'tool_b']);
  assert.equal(reply.content, '两件事都做完了。');
  const last = calls[1].messages[calls[1].messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, 2);
  assert.deepEqual(last.content.map((b) => b.tool_use_id), ['t1', 't2']);
});

test('工具 DENIED：真实失败回传，循环不中断，绝不假装成功', async () => {
  const calls = fetchStub([
    { content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], usage: {} },
    { content: [{ type: 'text', text: '抱歉，我没有权限写入，没能保存。' }], usage: {} },
  ]);
  const reply = await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '写一条' }],
    tools: [{ name: 'x', description: '', parameters: { type: 'object', properties: {} } }],
    callTool: async () => JSON.stringify({ code: 'DENIED', error: 'AI 无权创建「activity」' }),
  });
  assert.equal(reply.content, '抱歉，我没有权限写入，没能保存。');
  const last = calls[1].messages[calls[1].messages.length - 1];
  assert.ok(String(last.content[0].content).includes('DENIED'), 'DENIED 结果必须回传给模型');
});

test('callTool 抛异常：转为错误文本回传，聊天不中断', async () => {
  const calls = fetchStub([
    { content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], usage: {} },
    { content: [{ type: 'text', text: '工具出错了，我如实告诉你。' }], usage: {} },
  ]);
  const reply = await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '写' }],
    tools: [{ name: 'x', description: '', parameters: { type: 'object', properties: {} } }],
    callTool: async () => { throw new Error('数据库不可用'); },
  });
  assert.equal(reply.content, '工具出错了，我如实告诉你。');
  const last = calls[1].messages[calls[1].messages.length - 1];
  assert.ok(String(last.content[0].content).includes('工具调用出错'));
});

test('普通聊天（无工具）：只请求一次，请求体不下发 tools', async () => {
  const calls = fetchStub([{ content: [{ type: 'text', text: '你好呀，今天过得怎么样？' }], usage: {} }]);
  const reply = await chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(reply.content, '你好呀，今天过得怎么样？');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, undefined);
});

test('模型把 function_calls/thinking 当正文输出：后端剥离，不透传前端', async () => {
  const leak = '<function_calls>\n<invoke name="create_ai_activity">\n<parameter name="content">\n刚搬进 bunny\'s home。\n</parameter>\n</invoke>\n</function_calls>\n<thinking>let me try to create an AI activity and see what happens.</thinking>';
  global.fetch = async () => jsonResponse({ content: [{ type: 'text', text: '好的。\n' + leak + '\n已经写好了。' }], usage: {} });
  const reply = await chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: '编辑一个 ai activity' }] });
  assert.ok(reply.content.includes('好的。'));
  assert.ok(reply.content.includes('已经写好了。'));
  for (const tag of ['function_calls', 'invoke', 'parameter', 'thinking', 'bunny']) {
    assert.ok(!reply.content.includes(tag), `残留 ${tag}`);
  }
});

// ------------------------------------------------ toolEvents 回传（前端系统提示依据）

test('chat：回传 toolEvents（name + code），CREATED 才会被前端识别为成功写入', async () => {
  const calls = fetchStub([
    { content: [{ type: 'tool_use', id: 't1', name: 'create_ai_activity', input: { content: 'x' } }], usage: {} },
    { content: [{ type: 'text', text: '写好了。' }], usage: {} },
  ]);
  const reply = await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '写一条动态' }],
    tools: [{ name: 'create_ai_activity', description: '', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } }],
    callTool: async () => JSON.stringify({ code: 'CREATED', activity: { id: 'a1' } }),
  });
  assert.deepEqual(reply.toolEvents, [{ name: 'create_ai_activity', code: 'CREATED' }]);
});

test('chat：失败/DENIED 工具 code 如实回传（非 CREATED），前端不会误显示成功提示', async () => {
  const calls = fetchStub([
    { content: [{ type: 'tool_use', id: 't1', name: 'create_ai_activity', input: {} }], usage: {} },
    { content: [{ type: 'text', text: '抱歉。' }], usage: {} },
  ]);
  const reply = await chat({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '写' }],
    tools: [{ name: 'create_ai_activity', description: '', parameters: { type: 'object', properties: {} } }],
    callTool: async () => JSON.stringify({ code: 'DENIED', error: 'x' }),
  });
  assert.deepEqual(reply.toolEvents, [{ name: 'create_ai_activity', code: 'DENIED' }]);
});

test('chat：无工具调用时不返回多余 toolEvents（空数组，前端不渲染任何提示）', async () => {
  const calls = fetchStub([{ content: [{ type: 'text', text: '你好。' }], usage: {} }]);
  const reply = await chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(reply.toolEvents, []);
});

// ------------------------------------------------ OpenAI 兼容协议回归

test('OpenAI 兼容协议 tool_calls 循环不受重构影响（回归）', async () => {
  const calls = fetchStub([
    {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_task', arguments: '{"title":"测试任务"}' } }] } }],
      usage: {},
    },
    { choices: [{ message: { role: 'assistant', content: '任务已创建。' } }], usage: {} },
  ]);
  const executed = [];
  const reply = await chat({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '创建任务：测试任务' }],
    tools: [{ name: 'create_task', description: '新建任务', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
    callTool: async (name, args) => { executed.push({ name, args }); return JSON.stringify({ code: 'CREATED', task: { id: 't1', title: args.title } }); },
  });
  assert.equal(reply.content, '任务已创建。');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'create_task');
  assert.deepEqual(executed[0].args, { title: '测试任务' });
  const last = calls[1].messages[calls[1].messages.length - 1];
  assert.equal(last.role, 'tool');
  assert.equal(last.tool_call_id, 'call_1');
  assert.ok(String(last.content).includes('CREATED'));
});

test('OpenAI 兼容协议正文里的 XML 同样被剥离', async () => {
  global.fetch = async () => jsonResponse({ choices: [{ message: { content: '<function_calls><invoke name="x"><parameter name="y">z</parameter></invoke></function_calls>完成' } }], usage: {} });
  const reply = await chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(reply.content, '完成');
});

// ------------------------------------------------ create_ai_activity 真实落库

test('create_ai_activity：真实写入 ai.activities，返回 CREATED，留审计', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool, names } = buildDomainTools(user.id, 'test-model', { sessionId: 'sess-1' });
  assert.ok(names.includes('create_ai_activity'));

  const r = JSON.parse(await callTool('create_ai_activity', { content: "刚搬进 bunny's home。" }));
  assert.equal(r.code, 'CREATED');
  assert.equal(r.activity.text, "刚搬进 bunny's home。");
  assert.equal(r.activity.type, 'chat'); // 缺省类型
  assert.ok(r.activity.id);

  const state = await getState(user.id);
  assert.equal(state.ai.activities.length, 1);
  assert.equal(state.ai.activities[0].text, "刚搬进 bunny's home。");

  const log = state.ai.auditLog.find((a) => a.entityType === 'activity');
  assert.ok(log, '存在 activity 审计记录');
  assert.equal(log.action, 'create');
  assert.equal(log.actor, 'assistant');
  assert.equal(log.aiAction, 'create_ai_activity');
  assert.equal(log.conversationId, 'sess-1');
  assert.equal(log.after.text, "刚搬进 bunny's home。");
});

test('create_ai_activity：显式 type 生效，多次写入按新→旧排列', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  await callTool('create_ai_activity', { content: '第一条', type: 'memory' });
  await callTool('create_ai_activity', { content: '第二条' });
  const state = await getState(user.id);
  assert.equal(state.ai.activities.length, 2);
  assert.equal(state.ai.activities[0].text, '第二条'); // unshift：最新在前
  assert.equal(state.ai.activities[1].text, '第一条');
  assert.equal(state.ai.activities[1].type, 'memory');
});

test('create_ai_activity：缺 content 返回 FAILED 且不落库', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('create_ai_activity', {}));
  assert.equal(r.code, 'FAILED');
  assert.ok(r.error);
  const state = await getState(user.id);
  assert.equal(state.ai.activities.length, 0);
});

// ------------------------------------------------------- 权限与领域检测

test('activity 权限：AI 可新增/改写/删除自己的动态（CRUD）', () => {
  assert.equal(aiCan('activity', 'read'), true);
  assert.equal(aiCan('activity', 'create'), true);
  assert.equal(aiCan('activity', 'write'), true);
  assert.equal(aiCan('activity', 'delete'), true);
  assert.equal(aiCan('activity', 'update'), true); // update 映射到 write
});

test('「编辑一个 ai activity」能被领域检测命中，activity 在工具注入集合中', () => {
  assert.ok(detectDomains('那你现在编辑一个 ai activity。').includes('activity'));
  assert.ok(detectDomains('写一条动态记录一下').includes('activity'));
  assert.ok(TOOL_DOMAIN_SET.has('activity'));
});
