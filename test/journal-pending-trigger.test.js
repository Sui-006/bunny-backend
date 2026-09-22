// 「新日志待读」一次性触发机制（机制 A）测试。
// 覆盖：写新 Journal → 下一条聊天消息自动读取一次并消费；不每条都读；多篇批量；不聊天不读；
//       与 get_journal 自主读取（机制 B）并存；10/500/3000 上限；并发只读一次；读取失败保留 pending。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState, putState, markPendingJournal } from '../lib/domain.js';
import { consumePendingJournal, readJournalEntries, pendingJournalContextText, buildDomainTools } from '../lib/tools.js';
import { buildAIContext } from '../lib/context-builder.js';
import { createSession } from '../lib/db.js';

const J = (id, date, content, mood = '平静', time = '12:00') => ({ id, date, time, mood, moodSymbol: '', content });

// 模拟前端全量写穿：读现存状态 → 传入新 journal → markPendingJournal 判定 → putState 保存。
async function syncJournals(userId, journal) {
  const existing = await getState(userId);
  const body = { ...existing, journal };
  markPendingJournal(body, existing);
  await putState(userId, body);
}

async function mkUser(state = {}) {
  return createUser({ email: null, passwordHash: null, state });
}

// ---- 1. 无新 Journal → 不自动读取 ----
test('无新 Journal：consumePendingJournal 返回 consumed=false，不读取', async () => {
  const user = await mkUser({ journal: [] });
  const r = await consumePendingJournal(user.id);
  assert.deepEqual(r, { consumed: false, journals: [] });
});

// ---- 2. 写 1 篇 → 第一条消息自动读取 ----
test('写 1 篇新 Journal → 第一条消息自动读取并消费', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '今天去了公园')]);
  assert.equal((await getState(user.id)).pendingJournalRead, true); // 保存只置 pending，不读

  const r = await consumePendingJournal(user.id);
  assert.equal(r.consumed, true);
  assert.equal(r.journals.length, 1);
  assert.equal(r.journals[0].content, '今天去了公园');
  assert.equal((await getState(user.id)).pendingJournalRead, false); // 消费掉
});

// ---- 3. 第二条消息不再因为第一篇 Journal 读取 ----
test('消费后：第二条消息不再自动读取（机制 A 只触发一次）', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '今天去了公园')]);
  await consumePendingJournal(user.id); // 第一条消息消费
  const r2 = await consumePendingJournal(user.id); // 第二条消息
  assert.equal(r2.consumed, false);
  assert.deepEqual(r2.journals, []);
});

// ---- 4. 连续 3 篇 → 一次性批量处理（最近在前） ----
test('连续写 3 篇 → 第一条消息一次性读到全部（最近在前，批量不机械只读最后一条）', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [
    J('j3', '2026-09-22', '第三篇', '开心', '21:00'),
    J('j2', '2026-09-21', '第二篇', '平静', '20:00'),
    J('j1', '2026-09-20', '第一篇', '累', '19:00'),
  ]);
  const r = await consumePendingJournal(user.id);
  assert.equal(r.consumed, true);
  assert.equal(r.journals.length, 3);
  assert.deepEqual(r.journals.map((j) => j.id), ['j3', 'j2', 'j1']); // 最近在前
});

// ---- 5. 写 Journal 但没聊天 → 不读取、不消费 ----
test('写 Journal 后没有聊天：只置 pending，绝不调用读取/消费', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '只是先记下')]);
  const state = await getState(user.id);
  assert.equal(state.pendingJournalRead, true); // 仍待读
  assert.equal(state.journal.length, 1); // 日志数据完整未被动过
});

// ---- 6. 自动读取后，AI 仍可自主调用 get_journal（机制 B 不被关闭） ----
test('机制 A 消费后，AI 仍可自主调用 get_journal（机制 B 并存）', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '今天去了公园')]);
  await consumePendingJournal(user.id);

  const { callTool } = buildDomainTools(user.id, 'test-model');
  const g = JSON.parse(await callTool('get_journal', {}));
  assert.equal(g.code, 'OK');
  assert.equal(g.journal.length, 1);
  assert.equal(g.journal[0].content, '今天去了公园');
});

// ---- 7. 无 pending 时 get_journal 完全正常 ----
test('无 pending：get_journal 自主调用功能完全正常', async () => {
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '历史日志')] });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const g = JSON.parse(await callTool('get_journal', {}));
  assert.equal(g.code, 'OK');
  assert.equal(g.journal.length, 1);
  assert.equal(g.journal[0].content, '历史日志');
});

// ---- 8. 单条超 500 字 → 自动触发也受后端上限 ----
test('自动触发读取：单条超 500 字被截断到 500（truncated=true）', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '字'.repeat(2000))]);
  const r = await consumePendingJournal(user.id);
  assert.equal(r.journals[0].content.length, 500);
  assert.equal(r.journals[0].truncated, true);
});

// ---- 9. 总量超 3000 字 → 自动触发也受总量预算 ----
test('自动触发读取：多条日志合计不超过 3000 字', async () => {
  const user = await mkUser({ journal: [] });
  const many = Array.from({ length: 10 }, (_, i) => J('b' + i, '2026-09-' + String(i + 1).padStart(2, '0'), '字'.repeat(500)));
  await syncJournals(user.id, many);
  const r = await consumePendingJournal(user.id);
  const total = r.journals.reduce((s, j) => s + j.content.length, 0);
  assert.ok(total <= 3000, '总量不超过 3000 字');
  assert.ok(r.journals.length <= 10);
});

// ---- 10. 并发两条消息 → 同一 pending 只被自动读取一次 ----
test('快速并发两条消息：同一 pending 只被消费一次（CAS 保证）', async () => {
  const user = await mkUser({ journal: [] });
  await syncJournals(user.id, [J('j1', '2026-09-22', '今天去了公园')]);
  const [a, b] = await Promise.all([consumePendingJournal(user.id), consumePendingJournal(user.id)]);
  const consumedCount = [a, b].filter((r) => r.consumed).length;
  assert.equal(consumedCount, 1);
  assert.equal((await getState(user.id)).pendingJournalRead, false);
});

// ---- 11. 读取失败：保留 pending，绝不永久丢失待读日志 ----
test('读取异常安全：readJournalEntries 对缺失/空日志幂等不抛；pending 未消费前日志数据完整保留', async () => {
  assert.deepEqual(readJournalEntries({}, {}).journal, []);
  assert.deepEqual(readJournalEntries({ journal: null }, {}).journal, []);
  assert.deepEqual(readJournalEntries({ journal: [] }, {}).journal, []);

  // 未消费时 pending 保持 true、日志完整，绝不会因读取失败丢失待读日志（实现内 try/catch 回退保留 pending）
  const user = await mkUser({ journal: [J('j1', '2026-09-22', '待读内容')], pendingJournalRead: true });
  const state = await getState(user.id);
  assert.equal(state.pendingJournalRead, true);
  assert.equal(state.journal.length, 1);
});

// ---- 12. pendingJournalContextText：结构化注入文本（仅本轮，不永久） ----
test('pendingJournalContextText：把读取结果转成仅本轮注入的文本块', () => {
  const text = pendingJournalContextText([
    { date: '2026-09-22', time: '21:00', mood: '开心', content: '今天去了公园' },
  ]);
  assert.ok(text.includes('【用户刚写下的日志（本次自动读取，仅此一轮）】'));
  assert.ok(text.includes('2026-09-22'));
  assert.ok(text.includes('开心'));
  assert.ok(text.includes('今天去了公园'));
  assert.equal(pendingJournalContextText([]), '');
  assert.equal(pendingJournalContextText(null), '');
});

// ---- 13. 注入 buildAIContext：pendingJournalText 进入 system（受预算约束，不永久） ----
test('pendingJournalText 注入 buildAIContext 的 system 文本', async () => {
  const s = await createSession('触发注入');
  const user = await mkUser({ journal: [] });
  const doc = await getState(user.id);
  const built = await buildAIContext({
    sessionId: s.id, doc, settings: {}, content: '你好', model: 'deepseek-chat',
    pendingJournalText: pendingJournalContextText([{ date: '2026-09-22', time: '21:00', mood: '开心', content: '今天去了公园' }]),
  });
  assert.ok(built.system.includes('今天去了公园'));
  assert.ok(built.system.includes('本次自动读取'));
});

// ---- 14. markPendingJournal：新日志置 true，无关写穿保留标记 ----
test('markPendingJournal：新日志 id → 置 true；无新日志 → 保留现存标记；无关写穿不清除', () => {
  const existing = { journal: [{ id: 'j1' }], pendingJournalRead: false };
  // 出现新 id
  const d1 = markPendingJournal({ journal: [{ id: 'j2' }, { id: 'j1' }] }, existing);
  assert.equal(d1.pendingJournalRead, true);
  // 无新 id（仅编辑）且现存 pending=true → 保留 true
  const d2 = markPendingJournal({ journal: [{ id: 'j1' }] }, { journal: [{ id: 'j1' }], pendingJournalRead: true });
  assert.equal(d2.pendingJournalRead, true);
  // 无新 id 且现存 pending=false → 保持 false
  const d3 = markPendingJournal({ journal: [{ id: 'j1' }] }, { journal: [{ id: 'j1' }], pendingJournalRead: false });
  assert.equal(d3.pendingJournalRead, false);
  // 空传入 journal（前端无日志）不清除现存 pending
  const d4 = markPendingJournal({ journal: [] }, { journal: [{ id: 'j1' }], pendingJournalRead: true });
  assert.equal(d4.pendingJournalRead, true);
});
