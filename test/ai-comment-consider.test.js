// 回归测试：/comments/consider 事件入口必须把「真实 recordId」注入模型上下文，
// 且 commented 只有 comment_on_record 返回 CREATED/UPDATED 才算成功（NOT_FOUND/DENIED/FAILED 一律 false）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireAuth, issueToken } from '../lib/auth.js';
import { HttpError } from '../lib/rest.js';
import aiRouter, { considerCommentPrompt, commentSucceeded } from '../routes/ai.js';
import { config } from '../lib/config.js';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';

// ---- 复刻 server.js 的 express + requireAuth + ai 路由，listen(0) 走真实 fetch（与 memory-rest.test.js 同套） ----
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', requireAuth, aiRouter);
  app.use((err, req, res, next) => {
    if (err instanceof HttpError || (err && typeof err.status === 'number' && err.code)) {
      return res.status(err.status || 500).json({ success: false, error: { code: err.code || 'ERROR', message: err.message } });
    }
    res.status(err?.status || 500).json({ error: String(err?.message || 'Internal Server Error') });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server && server.close(); });

config.mock = false;
config.deepseekApiKey = 'test-deepseek-key';
config.deepseekBaseUrl = 'http://test-deepseek.local';

// 只拦截「模型」请求（deepseek/anthropic baseUrl），测试自身的 express 请求走真实 fetch。
const realFetch = global.fetch;
function stubModelFetch(turns) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://test-deepseek.local') || u.startsWith('http://test-anthropic.local')) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const t = turns[Math.min(calls.length - 1, turns.length - 1)];
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => t };
    }
    return realFetch(url, opts);
  };
  return calls;
}
after(() => { global.fetch = realFetch; });

// DeepSeek（OpenAI 兼容）响应：首轮 tool_call → 次轮最终文字。
function dsToolCall(name, args) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: {} };
}
function dsFinal(text) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: {} };
}

async function consider(recordType, recordId, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + '/api/ai/comments/consider', {
    method: 'POST', headers, body: JSON.stringify({ recordType, recordId, model: 'deepseek-chat' }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---- 1. recordId 注入：user message 必须包含真实 recordId ----
test('considerCommentPrompt 注入真实 recordId（模型不猜 id）', () => {
  const record = { id: 'record-123', date: '2026-09-23', mood: '开心', content: '今天散步。' };
  const msg = considerCommentPrompt('journal', 'record-123', record);
  assert.ok(msg.includes('记录类型：journal'));
  assert.ok(msg.includes('记录 ID：record-123'), '必须把真实 recordId 注入模型上下文');
  assert.ok(msg.includes('今天散步。'));
  assert.ok(considerCommentPrompt('finance', 'e-9', { id: 'e-9', title: '午饭', amountCents: 2500 }).includes('记录 ID：e-9'));
  assert.ok(considerCommentPrompt('health', 'h-7', { id: 'h-7', sleep: 7 }).includes('记录 ID：h-7'));
});

// ---- 2. commented 判定：只有 CREATED/UPDATED 算成功 ----
test('commentSucceeded：只有 CREATED/UPDATED 算成功，NOT_FOUND/DENIED/FAILED/缺码一律 false', () => {
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: 'CREATED' }]), true);
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: 'UPDATED' }]), true);
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: 'NOT_FOUND' }]), false);
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: 'DENIED' }]), false);
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: 'FAILED' }]), false);
  assert.equal(commentSucceeded([{ name: 'comment_on_record', code: undefined }]), false);
  assert.equal(commentSucceeded([{ name: 'comment_on_record' }]), false, '缺 code 不算成功');
  assert.equal(commentSucceeded([{ name: 'get_current_time', code: 'OK' }]), false, '别的工具不算评论');
  assert.equal(commentSucceeded([]), false);
  assert.equal(commentSucceeded(undefined), false);
});

// ---- 3. 端到端：模型原样用 recordId → CREATED → commented=true, persisted=true, 真实落库 ----
test('端到端：模型用注入的 recordId 调用 → CREATED → commented/persisted 均 true', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'record-123', date: '2026-09-23', mood: '开心', content: '今天和年糕散步。' }] } });
  const token = await issueToken(user.id);
  const calls = stubModelFetch([
    dsToolCall('comment_on_record', { recordType: 'journal', recordId: 'record-123', comment: '和年糕散步真好啊。' }),
    dsFinal('好。'),
  ]);
  const r = await consider('journal', 'record-123', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.data.considered, true);
  assert.equal(r.json.data.commented, true, 'CREATED 必须报 commented=true');
  assert.equal(r.json.data.persisted, true, '落库读回必须 persisted=true');
  // 请求体里必须真的把 recordId 喂给模型（不是只有摘要）
  const userMsg = calls[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('record-123'), '模型收到的 user message 必须包含真实 recordId');
  // 服务端真实落库
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 1);
  assert.equal(state.ai.comments[0].recordId, 'record-123');
  assert.equal(state.ai.comments[0].text, '和年糕散步真好啊。');
});

// ---- 4. 端到端：模型传错 recordId → NOT_FOUND → commented=false, persisted=false（绝不误报成功） ----
test('端到端：模型传错 recordId → NOT_FOUND → commented/persisted 均 false', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'record-123', date: '2026-09-23', content: '今天下雨。' }] } });
  const token = await issueToken(user.id);
  stubModelFetch([
    dsToolCall('comment_on_record', { recordType: 'journal', recordId: 'wrong-id', comment: '记得带伞。' }),
    dsFinal('好。'),
  ]);
  const r = await consider('journal', 'record-123', token);
  assert.equal(r.json.data.considered, true);
  assert.equal(r.json.data.commented, false, 'NOT_FOUND 绝不报 commented=true');
  assert.equal(r.json.data.persisted, false);
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 0, '错 id 绝不落库');
});

// ---- 5. 端到端：已有一条评论再评 → UPDATED → commented/persisted 均 true ----
test('端到端：重复评论 → UPDATED → commented/persisted 均 true', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { journal: [{ id: 'record-123', date: '2026-09-23', content: '今天写了代码。' }] } });
  const { callTool } = buildDomainTools(user.id, 'deepseek-chat');
  await callTool('comment_on_record', { recordType: 'journal', recordId: 'record-123', comment: '旧评论' });
  const token = await issueToken(user.id);
  stubModelFetch([
    dsToolCall('comment_on_record', { recordType: 'journal', recordId: 'record-123', comment: '新评论，更有料。' }),
    dsFinal('好。'),
  ]);
  const r = await consider('journal', 'record-123', token);
  assert.equal(r.json.data.commented, true);
  assert.equal(r.json.data.persisted, true);
  const state = await getState(user.id);
  assert.equal(state.ai.comments.length, 1, '同 (recordType,recordId) 只保留一条');
  assert.equal(state.ai.comments[0].text, '新评论，更有料。');
  assert.equal(state.ai.comments[0].version, 2, 'UPDATED 后 version+1');
});

// ---- 6. 前端关联：comment.recordId === record.id 时 aiCommentFor 谓词能反查到该评论 ----
test('前端关联：comment.recordId === record.id 时 aiCommentFor 谓词能得到该评论（不串绑）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { expenses: [{ id: 'e-1', title: '午饭', category: '吃饭', amountCents: 2500, kind: 'expense', occurredAt: '2026-09-23' }] } });
  const { callTool } = buildDomainTools(user.id, 'deepseek-chat');
  await callTool('comment_on_record', { recordType: 'finance', recordId: 'e-1', comment: '这顿吃得值。' });
  const state = await getState(user.id);
  // 与前端 aiCommentFor 完全一致的匹配谓词：(DB.ai.comments||[]).find(c => c.recordType===recordType && c.recordId===recordId)
  const aiCommentFor = (comments, recordType, recordId) => (comments || []).find((c) => c.recordType === recordType && c.recordId === recordId) || null;
  const record = state.expenses[0];
  const found = aiCommentFor(state.ai.comments, 'finance', record.id);
  assert.ok(found, 'record.id 能反查到评论');
  assert.equal(found.text, '这顿吃得值。');
  assert.equal(found.recordId, record.id, '评论绑定的 recordId 与 record.id 完全一致');
  assert.equal(aiCommentFor(state.ai.comments, 'finance', 'nonexistent'), null, '别的 id 查不到');
});
