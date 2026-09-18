import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendBarkRequest } from '../lib/bark.js';
import { sendNotification, resolveBarkUrl, maskBarkUrl, diagnoseNotification, NOTIFY_STATUS } from '../lib/notification-engine.js';
import { saveAppSettings } from '../lib/db.js';
import { config } from '../lib/config.js';

// 本地假 Bark HTTP 服务：按场景返回，测试绝不碰真实 Bark、不泄露 device token。
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

test('sendBarkRequest：未配置 → NOT_CONFIGURED', async () => {
  const r = await sendBarkRequest('', { title: 't', body: 'b', icon: '' });
  assert.equal(r.provider, 'bark');
  assert.equal(r.status, NOTIFY_STATUS.NOT_CONFIGURED);
});

test('sendBarkRequest：HTTP 2xx + body code:200 → SUCCESS', async () => {
  const s = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, message: 'success' }));
  });
  try {
    const r = await sendBarkRequest(urlOf(s), { title: '标题', body: '正文', icon: '' });
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.httpStatus, 200);
  } finally { await close(s); }
});

test('sendBarkRequest：非 2xx → FAILED（保留 httpStatus + errorCode）', async () => {
  const s = await listen((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401 }));
  });
  try {
    const r = await sendBarkRequest(urlOf(s), { title: 't', body: 'b', icon: '' });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.httpStatus, 401);
    assert.equal(r.errorCode, 'HTTP_401');
  } finally { await close(s); }
});

test('sendBarkRequest：HTTP 200 但 body code != 200 → FAILED（不假装成功）', async () => {
  const s = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 400, message: 'bad device token' }));
  });
  try {
    const r = await sendBarkRequest(urlOf(s), { title: 't', body: 'b', icon: '' });
    assert.equal(r.status, 'FAILED');
  } finally { await close(s); }
});

test('sendBarkRequest：连接拒绝 → FAILED NETWORK_ERROR', async () => {
  // 起服务拿到端口后立刻关闭，制造 ECONNREFUSED
  const s = await listen(() => {});
  const url = urlOf(s);
  await close(s);
  const r = await sendBarkRequest(url, { title: 't', body: 'b', icon: '' });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.errorCode, 'NETWORK_ERROR');
});

test('sendBarkRequest：超时 → TIMEOUT', async () => {
  const s = await listen(() => { /* 永不响应，靠短超时触发 abort */ });
  try {
    const r = await sendBarkRequest(urlOf(s), { title: 't', body: 'b', icon: '', timeoutMs: 150 });
    assert.equal(r.status, 'TIMEOUT');
    assert.equal(r.errorCode, 'TIMEOUT');
  } finally { await close(s); }
});

test('resolveBarkUrl：env BARK_URL 优先，app_settings.bark_url 兜底', async () => {
  config.barkUrl = 'https://env.example/tokAAAA';
  await saveAppSettings({ bark_url: 'https://db.example/tokBBBB' });
  assert.equal(await resolveBarkUrl(), 'https://env.example/tokAAAA');
  config.barkUrl = '';
  assert.equal(await resolveBarkUrl(), 'https://db.example/tokBBBB');
});

test('maskBarkUrl：只暴露末尾 4 位，绝不返回完整 token', async () => {
  const m = maskBarkUrl('https://api.day.app/supertok123456');
  assert.ok(!m.includes('supertok123456'));
  assert.equal(m, '••••••••3456');
});

test('sendNotification：未配置 Bark → NOT_CONFIGURED（不假装成功）', async () => {
  config.barkUrl = '';
  await saveAppSettings({ bark_url: '' });
  const r = await sendNotification({ title: 't', body: 'b', source: 'test', icon: '' });
  assert.equal(r.status, NOTIFY_STATUS.NOT_CONFIGURED);
  assert.equal(r.source, 'test');
});

test('sendNotification：经假 Bark 服务发送成功 → SUCCESS 且带 source', async () => {
  const s = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":200}');
  });
  try {
    config.barkUrl = urlOf(s);
    const r = await sendNotification({ title: '标题', body: '正文', level: 'normal', source: 'proactive', icon: '' });
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.source, 'proactive');
  } finally { await close(s); config.barkUrl = ''; }
});

test('diagnoseNotification：configured=true 且打码地址不泄露 token', async () => {
  config.barkUrl = 'https://api.day.app/secret123456789';
  const d = await diagnoseNotification();
  assert.equal(d.configured, true);
  assert.ok(!JSON.stringify(d).includes('secret123456789'));
  assert.equal(d.barkMasked, '••••••••6789');
  config.barkUrl = '';
});
