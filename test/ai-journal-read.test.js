// AI 读取用户日志（get_journal 只读工具增强）：query/mode/limit、硬性安全上限、结构化 JSON、只读不落库、权限拦截。
// 覆盖：recent/relevant/all、limit 上限 10、单条截断 500、总量预算、query 命中排序、只读不写、READ 权限、按需注入回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools } from '../lib/tools.js';
import { aiCan, AI_PERMISSION_POLICY } from '../lib/permissions.js';
import { detectToolDomains } from '../lib/aiContext.js';

function parse(json) { return JSON.parse(json); }

const JOURNALS = [
  { id: 'j1', date: '2026-09-15', time: '08:30', mood: '开心', moodSymbol: '😊', content: '今天去了公园散步，看到很多花。' },
  { id: 'j2', date: '2026-09-16', time: '20:10', mood: '平静', moodSymbol: '😐', content: '晚上加班到很晚，有点累。' },
  { id: 'j3', date: '2026-09-17', time: '19:00', mood: '担心', moodSymbol: '😟', content: '公园里的猫今天没来，有点担心它。' },
];

async function mkTool(state) {
  const user = await createUser({ email: null, passwordHash: null, state });
  const dt = buildDomainTools(user.id, 'test-model');
  return { userId: user.id, callTool: dt.callTool };
}

// ---- 1. 默认 recent：最近在前，字段完整，结构化 JSON（非 HTML） ----
test('mode=recent 缺省：最近在前，返回 id/date/time/mood/moodSymbol/content', async () => {
  const { callTool } = await mkTool({ journal: JOURNALS });
  const r = parse(await callTool('get_journal', {}));
  assert.equal(r.code, 'OK');
  assert.equal(r.mode, 'recent');
  assert.equal(r.count, 3);
  assert.equal(r.journal[0].id, 'j3'); // 最近在前
  assert.equal(r.journal[2].id, 'j1');
  const j = r.journal[0];
  assert.deepEqual(Object.keys(j).sort(), ['content', 'date', 'id', 'mood', 'moodSymbol', 'time', 'truncated'].sort());
  assert.equal(j.content, '公园里的猫今天没来，有点担心它。');
  assert.equal(j.truncated, false);
  assert.ok(!/</.test(JSON.stringify(r.journal)), '结构化 JSON，绝不夹带 HTML');
});

// ---- 2. mode=relevant + query：按相关性过滤排序 ----
test('mode=relevant + query：只返回命中关键词的日志，命中越强越靠前', async () => {
  const { callTool } = await mkTool({ journal: JOURNALS });
  const r = parse(await callTool('get_journal', { mode: 'relevant', query: '猫' }));
  assert.equal(r.code, 'OK');
  assert.equal(r.mode, 'relevant');
  assert.equal(r.count, 1);
  assert.equal(r.journal[0].id, 'j3'); // 只有 j3 提到猫
  assert.equal(r.journal[0].content, '公园里的猫今天没来，有点担心它。');
});

test('mode=relevant 无命中：返回空列表而非报错', async () => {
  const { callTool } = await mkTool({ journal: JOURNALS });
  const r = parse(await callTool('get_journal', { mode: 'relevant', query: '不存在的关键词xyz' }));
  assert.equal(r.code, 'OK');
  assert.equal(r.count, 0);
  assert.deepEqual(r.journal, []);
});

// ---- 3. mode=all 受 limit 上限 ----
test('mode=all：受 limit 上限钳制（单次最多 10 条，绝不无限返回）', async () => {
  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push({ id: 'd' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), mood: '平静', content: '第 ' + i + ' 天' });
  }
  const { callTool } = await mkTool({ journal: many });
  const r = parse(await callTool('get_journal', { mode: 'all', limit: 9999 }));
  assert.equal(r.code, 'OK');
  assert.equal(r.count, 10); // 上限 10
  assert.equal(r.journal.length, 10);
});

// ---- 4. limit 钳制到 10 ----
test('limit 超上限被钳制到 10', async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: 'x' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), content: 'c' + i }));
  const { callTool } = await mkTool({ journal: many });
  const r = parse(await callTool('get_journal', { limit: 999 }));
  assert.equal(r.journal.length, 10);
});

// ---- 5. 单条截断 500 字 + truncated 标记 ----
test('单条超 500 字被截断到 500，并标 truncated=true（绝不整段泄漏）', async () => {
  const long = '字'.repeat(2000);
  const { callTool } = await mkTool({ journal: [{ id: 'big', date: '2026-09-01', mood: '平静', content: long }] });
  const r = parse(await callTool('get_journal', { limit: 1 }));
  assert.equal(r.journal[0].content.length, 500);
  assert.equal(r.journal[0].truncated, true);
  assert.ok(long.startsWith(r.journal[0].content));
});

// ---- 6. 返回总量预算 3000 字 ----
test('返回总量预算：多条长日志合计不超过 3000 字', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), content: '字'.repeat(500) }));
  const { callTool } = await mkTool({ journal: many });
  const r = parse(await callTool('get_journal', { limit: 10 }));
  const total = r.journal.reduce((s, j) => s + j.content.length, 0);
  assert.ok(total <= 3000, '总量不超过 3000 字');
  assert.ok(r.journal.length <= 10);
});

// ---- 7. 只读：读日志绝不写动态/不改日志/不产生审计 ----
test('get_journal 只读：不写 AI 动态、不改日志、不落审计', async () => {
  const { userId, callTool } = await mkTool({ journal: JOURNALS });
  const before = JSON.stringify((await getState(userId)).journal);
  const r = parse(await callTool('get_journal', { mode: 'relevant', query: '猫' }));
  assert.equal(r.code, 'OK');
  const state = await getState(userId);
  assert.equal(JSON.stringify(state.journal), before); // 日志原样
  assert.equal(state.ai.activities.length, 0); // 读日志 ≠ 写动态
  assert.equal((state.ai.auditLog || []).length, 0); // 只读不审计
});

// ---- 8. 权限：READ 允许 / denied 拦截 ----
test('journal READ 允许', () => {
  assert.equal(aiCan('journal', 'read'), true);
});

test('journal READ denied 时返回 DENIED（不改数据）', async () => {
  const { callTool } = await mkTool({ journal: JOURNALS });
  const saved = AI_PERMISSION_POLICY.journal;
  AI_PERMISSION_POLICY.journal = { read: false, create: false, write: false, delete: false, comment: false };
  try {
    const r = parse(await callTool('get_journal', {}));
    assert.equal(r.code, 'DENIED');
  } finally {
    AI_PERMISSION_POLICY.journal = saved;
  }
});

// ---- 9. 纯本地读，绝不触发网络 ----
test('get_journal 是纯本地操作，绝不发起网络/provider 请求', async () => {
  const { callTool } = await mkTool({ journal: JOURNALS });
  const orig = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('不应调用网络'); };
  try {
    const r = parse(await callTool('get_journal', { mode: 'relevant', query: '猫' }));
    assert.equal(r.code, 'OK');
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = orig;
  }
});

// ---- 10. 按需注入回归：回忆性表达命中 journal，普通闲聊绝不命中 ----
test('回忆性表达（记得/以前/写过/回忆）命中 journal 工具领域；「今天心情不错」不命中', () => {
  for (const q of ['你记得我以前写过日记吗', '我之前有没有写过类似的事', '回忆一下那天的经历', '查一下我的日志']) {
    assert.ok(detectToolDomains(q).includes('journal'), `「${q}」应命中 journal`);
  }
  assert.ok(!detectToolDomains('今天心情不错').includes('journal'), '普通闲聊绝不误触发 journal');
});

// ---- 11. 空日志稳定返回空结果 ----
test('journal 为空时返回稳定空结果（非报错）', async () => {
  const { callTool } = await mkTool({});
  const r = parse(await callTool('get_journal', {}));
  assert.equal(r.code, 'OK');
  assert.deepEqual(r.journal, []);
  assert.equal(r.count, 0);
});
