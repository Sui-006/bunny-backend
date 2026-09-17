import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { HttpError } from '../lib/rest.js';
import memoryRouter from '../routes/memory.js';

// REST 集成测试：用真实 Express app + requireAuth + memory 路由，listen(0) 后走 fetch。
// 无 .env → store 落内存，进程内隔离，可安全断言。
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/memories', requireAuth, memoryRouter);
  // 复刻 server.js 的统一错误处理（HttpError / status+code → 结构化 JSON）
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

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, contentType: res.headers.get('content-type') || '', text };
}

test('REST 读：GET /api/memories 返回 JSON 列表', async () => {
  const r = await api('GET', '/api/memories');
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.ok(Array.isArray(r.json.data.memories));
  assert.equal(typeof r.json.data.version, 'number');
});

test('REST 增：POST /api/memories 创建并写回，GET 可见（API 是真实数据源）', async () => {
  const created = await api('POST', '/api/memories', { summary: '我喜欢喝咖啡', category: 'preference', key: 'drink' });
  assert.equal(created.status, 201);
  assert.equal(created.json.success, true);
  assert.equal(created.json.data.memory.summary, '我喜欢喝咖啡');
  const id = created.json.data.memory.id;
  const list = await api('GET', '/api/memories');
  assert.ok(list.json.data.memories.some((m) => m.id === id)); // 服务端真正落库
});

test('REST 改：PATCH /api/memories/:id 更新摘要', async () => {
  const created = await api('POST', '/api/memories', { summary: '旧摘要', category: 'preference', key: 'edit_me' });
  const id = created.json.data.memory.id;
  const patched = await api('PATCH', '/api/memories/' + id, { summary: '新摘要' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.memory.summary, '新摘要');
});

test('REST 删：DELETE /api/memories/:id 删除', async () => {
  const created = await api('POST', '/api/memories', { summary: '待删除', category: 'preference', key: 'del_me' });
  const id = created.json.data.memory.id;
  const del = await api('DELETE', '/api/memories/' + id);
  assert.equal(del.status, 200);
  assert.equal(del.json.data.ok, true);
  const got = await api('GET', '/api/memories/' + id);
  assert.equal(got.status, 404);
});

test('REST 停用：POST /:id/deactivate 后不在活动列表，但仍可恢复', async () => {
  const created = await api('POST', '/api/memories', { summary: '暂时不用', category: 'preference', key: 'off_me' });
  const id = created.json.data.memory.id;
  const off = await api('POST', '/api/memories/' + id + '/deactivate');
  assert.equal(off.status, 200);
  assert.equal(off.json.data.memory.isActive, false);
  const list = await api('GET', '/api/memories');
  assert.ok(!list.json.data.memories.some((m) => m.id === id)); // 默认不含停用
});

test('REST 恢复：POST /:id/restore 重新激活', async () => {
  const created = await api('POST', '/api/memories', { summary: '要恢复', category: 'preference', key: 'on_me' });
  const id = created.json.data.memory.id;
  await api('POST', '/api/memories/' + id + '/deactivate');
  const on = await api('POST', '/api/memories/' + id + '/restore');
  assert.equal(on.status, 200);
  assert.equal(on.json.data.memory.isActive, true);
});

test('REST 清空：POST /clear 清空记忆但不影响后续写入', async () => {
  await api('POST', '/api/memories', { summary: '清空前', category: 'preference', key: 'pre_clear' });
  const clr = await api('POST', '/api/memories/clear');
  assert.equal(clr.status, 200);
  assert.equal(clr.json.data.ok, true);
  const list = await api('GET', '/api/memories');
  assert.equal(list.json.data.memories.length, 0);
});

test('API 错误恒为 JSON：404 / 422 均结构化，非 HTML；敏感写入失败不落库', async () => {
  // 404
  const missing = await api('GET', '/api/memories/no-such-id');
  assert.equal(missing.status, 404);
  assert.ok(missing.contentType.includes('application/json'));
  assert.equal(missing.json.success, false);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  // 422 敏感信息（失败回滚：不落库）
  const before = await api('GET', '/api/memories');
  const sensitive = await api('POST', '/api/memories', { summary: '我的密码是 abc123' });
  assert.equal(sensitive.status, 422);
  assert.ok(sensitive.contentType.includes('application/json'));
  assert.equal(sensitive.json.success, false);
  assert.equal(sensitive.json.error.code, 'SENSITIVE_CONTENT');
  const afterList = await api('GET', '/api/memories');
  assert.equal(afterList.json.data.memories.length, before.json.data.memories.length); // 未写入
});
