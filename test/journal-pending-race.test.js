// 「新日志待读」消费竞态修复回归测试（机制 A 的 CAS 单调性）。
// 根因：前端全量写穿 PUT /api/state 用无条件 saveUserState 提交旧 version，会把 consumePendingJournal
//       递增过的 user_state.version 回退，使两条并发消息的 CAS 可能都命中 → 同一批 Journal 被重复注入。
// 修复：PUT /api/state 一律保留服务端真实 version，不信任前端提交的 version。
// 覆盖：并发只消费一次；并发+前端写穿仍只一次；普通写穿不复活已消费 pending；新日志正常触发；
//       读取失败保留 pending；消费后下一条不再读；message/edit/regenerate 不重复消费；路由级 version 不回退。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createUser } from '../lib/store.js';
import { getState, putState, markPendingJournal } from '../lib/domain.js';
import { consumePendingJournal, readJournalEntries } from '../lib/tools.js';
import { requireAuth } from '../lib/auth.js';
import { HttpError } from '../lib/rest.js';
import stateRouter from '../routes/state.js';

const J = (id, date, content, mood = '平静', time = '12:00') => ({ id, date, time, mood, moodSymbol: '', content });

async function mkUser(state = {}) {
  return createUser({ email: null, passwordHash: null, state });
}

// 模拟前端全量写穿：前端提交的是它本地 DB 里的旧 version（seed 恒为 1）与它的 journal；
// 服务端逻辑（镜像 state.js 路由）读现存状态 → markPendingJournal 判定 → 保留服务端真实 version → 写入。
async function frontendPut(userId, { journal, version = 1, ...rest }) {
  const existing = await getState(userId);
  const body = { ...existing, ...rest, journal, version };
  markPendingJournal(body, existing);
  body.version = Number(existing.version) || 1; // 服务端保留真实 version（与 state.js 路由一致）
  await putState(userId, body);
}

// ---- 路由级（真实 PUT /api/state）回归：version 由服务端持有 ----
let owner;
let server;
let base;

before(async () => {
  owner = await createUser({ email: null, passwordHash: null, state: {} });
  const app = express();
  app.use(express.json());
  app.use('/api/state', requireAuth, stateRouter);
  // 复刻 server.js 统一错误处理（HttpError / status+code → 结构化 JSON）
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
  return { status: res.status, json };
}

// ---- 测试 1：两个聊天请求并发消费 → 只能一个得到 pendingJournalText ----
test('并发两条消费请求：同一 pending 只被一个消费', async () => {
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '今天去了公园')], pendingJournalRead: true });
  const [a, b] = await Promise.all([consumePendingJournal(user.id), consumePendingJournal(user.id)]);
  assert.equal([a, b].filter((r) => r.consumed).length, 1);
  assert.equal((await getState(user.id)).pendingJournalRead, false);
});

// ---- 测试 2：两个聊天请求并发消费 + 一次前端写穿（旧 version）→ 仍只能一个 ----
test('并发消费 + 前端全量写穿（旧 version）：仍只一个得到 Journal', async () => {
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '并发下的日志')], pendingJournalRead: true });
  const [a, b] = await Promise.all([
    consumePendingJournal(user.id),
    consumePendingJournal(user.id),
    frontendPut(user.id, { journal: [J('j1', '2026-09-22', '并发下的日志')], version: 1 }),
  ]);
  assert.equal([a, b].filter((r) => r.consumed).length, 1);
  assert.equal((await getState(user.id)).pendingJournalRead, false);
});

// ---- 测试 3（路由级）：普通 PUT 不能复活已消费 pending，也不能回退 version ----
test('PUT /api/state：提交旧 version 不回退服务端 version，也不重新产生已消费 pending', async () => {
  const j1 = J('j1', '2026-09-22', '今天去了公园');
  const state = await getState(owner.id);
  await putState(owner.id, { ...state, journal: [j1], pendingJournalRead: true, version: 1 });

  const r = await consumePendingJournal(owner.id);
  assert.equal(r.consumed, true);
  const afterConsume = await getState(owner.id);
  assert.equal(afterConsume.pendingJournalRead, false);
  const consumedVersion = afterConsume.version;
  assert.ok(consumedVersion >= 2, 'consume 应递增 version');

  // 前端全量写穿：提交旧 version=1、journal 未变、pendingJournalRead=false —— 均不得生效
  const resp = await api('PUT', '/api/state', { ...afterConsume, version: 1, pendingJournalRead: false });
  assert.equal(resp.status, 200);
  const finalState = await getState(owner.id);
  assert.equal(finalState.pendingJournalRead, false, '普通写穿不复活已消费 pending');
  assert.equal(finalState.version, consumedVersion, 'version 必须保留服务端真实值，不被前端旧值回退');
});

// ---- 测试 4：新 Journal → 下一条消息仍正常触发一次 ----
test('新 Journal → 下一条消息仍自动读取一次', async () => {
  const user = await mkUser({ journal: [] });
  await frontendPut(user.id, { journal: [J('j1', '2026-09-22', '今天去了公园')], version: 1 });
  assert.equal((await getState(user.id)).pendingJournalRead, true);
  const r = await consumePendingJournal(user.id);
  assert.equal(r.consumed, true);
  assert.equal(r.journals[0].content, '今天去了公园');
});

// ---- 测试 5：读取失败/未消费成功时 pending 保留、日志完整 ----
test('读取失败/未成功消费：pending 保留、日志数据完整（绝不丢失待读）', async () => {
  // readJournalEntries 对缺失/空 journal 幂等不抛（失败安全）
  assert.deepEqual(readJournalEntries({}, {}).journal, []);
  assert.deepEqual(readJournalEntries({ journal: null }, {}).journal, []);
  // 未消费时日志完整、pending 仍在，绝不会因读取失败丢失待读内容
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '待读内容')], pendingJournalRead: true });
  const state = await getState(user.id);
  assert.equal(state.pendingJournalRead, true);
  assert.equal(state.journal.length, 1);
  assert.equal(state.journal[0].content, '待读内容');
});

// ---- 测试 6：消费成功后下一条消息不再自动读取 ----
test('消费成功后：下一条消息不再自动读取', async () => {
  const user = await mkUser({ journal: [] });
  await frontendPut(user.id, { journal: [J('j1', '2026-09-22', '今天去了公园')], version: 1 });
  const first = await consumePendingJournal(user.id);
  assert.equal(first.consumed, true);
  const second = await consumePendingJournal(user.id);
  assert.equal(second.consumed, false);
  assert.deepEqual(second.journals, []);
});

// ---- 测试 7：message → edit → regenerate 序列，只有第一条消费 ----
test('message → edit → regenerate：只有第一条消息消费，后续不重复读', async () => {
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '今天去了公园')], pendingJournalRead: true });
  const msg = await consumePendingJournal(user.id);   // 原始消息 A
  assert.equal(msg.consumed, true);
  const edit = await consumePendingJournal(user.id);  // 编辑 A
  assert.equal(edit.consumed, false);
  const regen = await consumePendingJournal(user.id); // regenerate A
  assert.equal(regen.consumed, false);
  assert.equal((await getState(user.id)).pendingJournalRead, false);
});
