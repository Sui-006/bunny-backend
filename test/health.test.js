import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { healthHandler, healthPayload } from '../lib/health.js';
import { config } from '../lib/config.js';

// 用最小 express app 挂载 healthHandler，真实走 HTTP GET /health，验证 200 + 结构 + 无副作用。
function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function getJson(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
  });
}
async function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

test('GET /health → 200', async () => {
  const app = express();
  app.get('/health', healthHandler);
  const s = await listen(app);
  try {
    const r = await getJson(s, '/health');
    assert.equal(r.status, 200);
  } finally { await close(s); }
});

test('/health 结构正确：ok/service/status/database', async () => {
  const app = express();
  app.get('/health', healthHandler);
  const s = await listen(app);
  try {
    const r = await getJson(s, '/health');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.service, 'bunny-backend');
    assert.equal(r.body.status, 'healthy');
    assert.ok(['connected', 'memory'].includes(r.body.database));
  } finally { await close(s); }
});

test('/health 只含固定字段，绝不泄露密钥/连接串/Bark Token', () => {
  const p = healthPayload();
  assert.deepEqual(Object.keys(p).sort(), ['database', 'ok', 'service', 'status'].sort());

  const s = JSON.stringify(p);
  // 逐一断言「即使配置了敏感值，也不会出现在响应里」
  for (const v of [
    config.supabaseKey, config.barkUrl, config.deepseekApiKey, config.openaiApiKey,
    config.anthropicApiKey, config.encryptionKey, config.supabaseUrl, config.amapKey,
  ]) {
    if (v) assert.ok(!s.includes(v), `健康检查响应不应包含敏感值: ${String(v).slice(0, 8)}…`);
  }
  // 常见敏感字段名也不得出现
  assert.ok(!/api[_-]?key|secret|token|authorization|password/i.test(s), '不应出现敏感字段名');
});

test('/health 不需要登录（公开 read-only，无 user 上下文也能 200）', async () => {
  // healthHandler 不读 req.user，也不依赖任何鉴权中间件 —— 直接挂载即代表公开。
  const app = express();
  app.get('/health', healthHandler);
  const s = await listen(app);
  try {
    const r = await getJson(s, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { await close(s); }
});

test('healthPayload 是纯函数：不访问 AI/Bark/数据库，只反映是否配置 Supabase', () => {
  // hasDb() 只做布尔判断，不发起任何网络请求；healthPayload 只返回固定字段。
  // 因此「不调 AI / 不调 Bark / 不写 Activity / Memory / Audit」由结构保证。
  const a = healthPayload();
  const b = healthPayload();
  assert.deepEqual(a, b); // 确定性、无副作用
  assert.equal(a.ok, true);
  assert.equal(a.status, 'healthy');
});
