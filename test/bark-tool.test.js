import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildDomainTools, AI_NOTIFY_TOOL_NAMES } from '../lib/tools.js';
import { aiCan, TOOL_ACTIONS } from '../lib/permissions.js';
import { createUser } from '../lib/store.js';
import { getState, aiActivities } from '../lib/domain.js';
import { config } from '../lib/config.js';
import { saveAppSettings } from '../lib/db.js';

// 本地假 Bark HTTP 服务：测试绝不碰真实 Bark，也不泄露 device token。
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}/tok1234567890`;
async function close(s) {
  if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
  await new Promise((r) => s.close(r));
}

after(() => { config.barkUrl = ''; });

// 从 buildDomainTools 返回的 tools 里取 send_bark_notification 定义
const barkTool = (tools) => tools.find((t) => t.name === 'send_bark_notification');

test('send_bark_notification 已注册到 Tool Registry（names 含它）', async () => {
  assert.ok(AI_NOTIFY_TOOL_NAMES.includes('send_bark_notification'));
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { names } = buildDomainTools(user.id, 'test-model');
  assert.ok(names.includes('send_bark_notification'));
});

test('schema：title/body required；参数绝不暴露 barkUrl/userId/key/token/secret', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { tools } = buildDomainTools(user.id, 'test-model');
  const t = barkTool(tools);
  assert.ok(t, '应有 send_bark_notification 定义');
  const props = t.parameters.properties;
  assert.deepEqual(t.parameters.required, ['title', 'body']);
  for (const forbidden of ['barkUrl', 'bark_url', 'barkKey', 'apiKey', 'token', 'secret', 'userId', 'user_id']) {
    assert.ok(!(forbidden in props), `工具参数不应暴露 ${forbidden}`);
  }
  assert.ok(props.title && props.body);
  assert.equal(props.level.enum[0], 'normal');
  assert.equal(props.level.enum[1], 'time_sensitive');
});

test('权限：notification 只能 create（发送），read/write/delete 全 false', () => {
  assert.equal(aiCan('notification', 'create'), true);
  assert.equal(aiCan('notification', 'read'), false);
  assert.equal(aiCan('notification', 'write'), false);
  assert.equal(aiCan('notification', 'delete'), false);
  assert.equal(TOOL_ACTIONS.send_bark_notification.entity, 'notification');
  assert.equal(TOOL_ACTIONS.send_bark_notification.action, 'create');
});

test('发送成功 → SUCCESS：真实 HTTP 请求、method GET、tool_result 不含 token', async () => {
  let reqMethod = null;
  let reqUrl = null;
  const s = await listen((req, res) => {
    reqMethod = req.method;
    reqUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    const raw = await callTool('send_bark_notification', { title: '喝水提醒', body: '该喝水啦～' });
    const r = JSON.parse(raw);
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.provider, 'bark');
    assert.equal(r.code, 'OK');
    assert.equal(r.message, 'Notification sent successfully');
    assert.ok(!raw.includes('tok1234567890'), 'tool_result 不得含 device token');
    assert.equal(reqMethod, 'GET');
    assert.ok(reqUrl.includes(encodeURIComponent('喝水提醒')), '标题应进入 Bark URL');
    assert.ok(reqUrl.includes(encodeURIComponent('该喝水啦～')), '正文应进入 Bark URL');
    assert.ok(!reqUrl.includes('critical'), '普通通知不得 critical');
    assert.ok(!reqUrl.includes('call=1'), '普通通知不得 call');
  } finally { await close(s); config.barkUrl = ''; }
});

test('Bark 401 → FAILED（真实失败，不假装成功）', async () => {
  const s = await listen((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    const r = JSON.parse(await callTool('send_bark_notification', { title: 't', body: 'b' }));
    assert.equal(r.status, 'FAILED');
    assert.equal(r.errorCode, 'HTTP_401');
    assert.equal(r.code, 'FAILED');
  } finally { await close(s); config.barkUrl = ''; }
});

test('Bark 500 → FAILED', async () => {
  const s = await listen((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 500 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    const r = JSON.parse(await callTool('send_bark_notification', { title: 't', body: 'b' }));
    assert.equal(r.status, 'FAILED');
    assert.equal(r.errorCode, 'HTTP_500');
  } finally { await close(s); config.barkUrl = ''; }
});

test('未配置 Bark → NOT_CONFIGURED（不假装成功）', async () => {
  config.barkUrl = '';
  await saveAppSettings({ bark_url: '' });
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('send_bark_notification', { title: 't', body: 'b' }));
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(r.provider, 'bark');
  assert.equal(r.code, 'NOT_CONFIGURED');
});

test('level=alarm 被降级为 normal（AI 工具绝不触发 critical/call）', async () => {
  let reqUrl = null;
  const s = await listen((req, res) => {
    reqUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    const r = JSON.parse(await callTool('send_bark_notification', { title: 't', body: 'b', level: 'alarm' }));
    assert.equal(r.status, 'SUCCESS');
    assert.ok(!reqUrl.includes('critical') && !reqUrl.includes('call=1') && !reqUrl.includes('volume=5'), 'alarm 应被降级为 normal');
  } finally { await close(s); config.barkUrl = ''; }
});

test('发送落审计（entityType=notification、actor=assistant）且审计不含 secret', async () => {
  const s = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    await callTool('send_bark_notification', { title: '喝水提醒', body: '该喝水啦', reason: '用户要求提醒喝水' });
    const state = await getState(user.id);
    const log = state.ai.auditLog.find((a) => a.entityType === 'notification');
    assert.ok(log, '应存在通知审计');
    assert.equal(log.action, 'send_bark_notification');
    assert.equal(log.aiAction, 'send_bark_notification');
    assert.equal(log.actor, 'assistant');
    assert.equal(log.reason, '用户要求提醒喝水');
    assert.equal(log.entityLabel, 'Bark 通知：喝水提醒');
    assert.ok(!JSON.stringify(log).includes('tok1234567890'), '审计不得含 device token');
  } finally { await close(s); config.barkUrl = ''; }
});

test('发送 Bark 不自动创建 AI Activity', async () => {
  const s = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const before = aiActivities(await getState(user.id)).length;
    const { callTool } = buildDomainTools(user.id, 'test-model');
    await callTool('send_bark_notification', { title: 't', body: 'b' });
    const afterCount = aiActivities(await getState(user.id)).length;
    assert.equal(afterCount, before, 'Bark 推送 ≠ AI Activity');
  } finally { await close(s); config.barkUrl = ''; }
});

test('缺少 title/body → FAILED，不发 HTTP', async () => {
  config.barkUrl = '';
  await saveAppSettings({ bark_url: '' });
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = JSON.parse(await callTool('send_bark_notification', { title: '', body: '' }));
  assert.equal(r.status, 'FAILED');
  assert.equal(r.errorCode, 'MISSING_TITLE_OR_BODY');
});

test('不传 barkUrl 也能发送（URL 从后端配置读取，AI 无需也不能传）', async () => {
  let hit = false;
  const s = await listen((req, res) => {
    hit = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200 }));
  });
  try {
    config.barkUrl = urlOf(s);
    const user = await createUser({ email: null, passwordHash: null, state: {} });
    const { callTool } = buildDomainTools(user.id, 'test-model');
    // 故意塞一个假的 barkUrl 参数：工具必须忽略它，用后端配置
    const r = JSON.parse(await callTool('send_bark_notification', { title: 't', body: 'b', barkUrl: 'https://evil.example/tokEVIL' }));
    assert.equal(r.status, 'SUCCESS');
    assert.ok(hit, '应真实发送到后端配置的 Bark');
    assert.ok(!JSON.stringify(r).includes('tokEVIL'), '不得回显攻击者传入的 URL');
  } finally { await close(s); config.barkUrl = ''; }
});
