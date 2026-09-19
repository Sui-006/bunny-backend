// AI READ 经期逐日记录（menstrualDays）工具层测试。
// 覆盖：只读当前用户、字段完整性、日期范围/limit、非法入参拒绝、权限（READ 允许 / CREATE-WRITE-DELETE 拒绝）、
//       现有写工具对 AI 关闭、不经任何 AI provider（无 DeepSeek 调用）、不影响周期/预测工具与用户前端记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../lib/store.js';
import { getState } from '../lib/domain.js';
import { buildDomainTools, toolsForDomains } from '../lib/tools.js';
import { aiCan, AI_PERMISSION_POLICY, TOOL_ACTIONS } from '../lib/permissions.js';
import { detectToolDomains } from '../lib/aiContext.js';
import { startCycle, endCycle } from '../lib/menstrual.js';
import { upsertMenstrualDay } from '../lib/frontend-logic.js';
import { supportsToolCalling } from '../lib/ai.js';

// 统一的逐日记录样本
const DAYS = [
  { date: '2026-09-15', period: true, flow: '中', symptoms: ['腹痛', '疲劳'], spotting: false, bbt: 36.5 },
  { date: '2026-09-16', period: true, flow: '少', symptoms: [], spotting: true, bbt: 36.6 },
  { date: '2026-09-17', period: false, flow: null, symptoms: ['头痛'], spotting: false, bbt: null },
];

function parse(json) { return JSON.parse(json); }

// ---- 工具已正式注册（TOOL_ACTIONS 精确到 menstrualDays 实体） ----
test('get_menstrual_records 已注册：entity=menstrual、entityKey=menstrualDays、action=read', () => {
  assert.deepEqual(TOOL_ACTIONS.get_menstrual_records, { entity: 'menstrual', entityKey: 'menstrualDays', action: 'read' });
});

// ---- 按需注入：月经/经量/痛经/点滴出血/基础体温 等命中 menstrual 领域才注入，绝不常驻 ----
test('按需注入：经量/痛经/点滴出血/基础体温/menstrual/cycle 命中 menstrual 工具领域', () => {
  for (const q of ['我最近经量怎么样', '我有点痛经', '今天基础体温多少', '最近有没有点滴出血', 'my menstrual cycle', 'period 记录']) {
    assert.ok(detectToolDomains(q).includes('menstrual'), `「${q}」应命中经期工具领域`);
  }
  const names = toolsForDomains(['menstrual']).map((t) => t.name);
  assert.ok(names.includes('get_menstrual_records'), '命中经期时注入只读逐日记录工具');
  assert.ok(names.includes('get_menstrual_cycles'));
  // 普通闲聊不命中经期，绝不常驻注入
  assert.ok(!detectToolDomains('今天天气不错').includes('menstrual'));
});

// ---- 1/2. 读取当前用户 + 返回字段完整 ----
test('读取当前用户 menstrualDays，返回 period/flow/symptoms/spotting/bbt', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool, names } = buildDomainTools(user.id, 'test-model');
  assert.ok(names.includes('get_menstrual_records'));

  const r = parse(await callTool('get_menstrual_records', {}));
  assert.equal(r.code, 'OK');
  assert.equal(r.source, 'menstrualDays');
  assert.equal(r.isPrediction, false);
  assert.equal(r.count, 3);
  assert.equal(r.records.length, 3);

  // 最近在前（降序）
  assert.equal(r.records[0].date, '2026-09-17');
  const d15 = r.records.find((x) => x.date === '2026-09-15');
  assert.equal(d15.period, true);
  assert.equal(d15.flow, '中');
  assert.deepEqual(d15.symptoms, ['腹痛', '疲劳']);
  assert.equal(d15.spotting, false);
  assert.equal(d15.bbt, 36.5);

  const d17 = r.records.find((x) => x.date === '2026-09-17');
  assert.equal(d17.period, false);
  assert.equal(d17.flow, null);
  assert.deepEqual(d17.symptoms, ['头痛']);
  assert.equal(d17.spotting, false);
  assert.equal(d17.bbt, null);
});

// ---- 3. 只读取当前用户（用户隔离，不越权读他人） ----
test('只读取当前用户：绝不返回其他用户的 menstrualDays', async () => {
  const a = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const b = await createUser({
    email: null, passwordHash: null,
    state: { menstrualDays: [{ date: '2026-09-10', period: true, flow: '多', symptoms: [], spotting: false, bbt: 37.0 }] },
  });
  const { callTool } = buildDomainTools(a.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', {}));
  const dates = r.records.map((x) => x.date);
  assert.ok(dates.includes('2026-09-15'));
  assert.ok(!dates.includes('2026-09-10'), '不得混入用户 B 的记录');
});

// ---- 4/5. 不接受 userId / documentId 越权 ----
test('不接受 userId：传他人 userId 仍只读当前用户', async () => {
  const a = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const b = await createUser({
    email: null, passwordHash: null,
    state: { menstrualDays: [{ date: '2026-09-10', period: true }] },
  });
  const { callTool } = buildDomainTools(a.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { userId: b.id }));
  const dates = r.records.map((x) => x.date);
  assert.ok(dates.includes('2026-09-15'));
  assert.ok(!dates.includes('2026-09-10'), 'userId 参数被忽略，不得读到 B');
});

test('不接受 documentId：传任意 documentId 仍只读当前用户', async () => {
  const a = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(a.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { documentId: 'some-other-user-doc' }));
  const dates = r.records.map((x) => x.date);
  assert.deepEqual(dates, ['2026-09-17', '2026-09-16', '2026-09-15']);
});

// ---- 6/7. 日期范围过滤 ----
test('startDate 正确过滤（只返回 >= startDate）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { startDate: '2026-09-16' }));
  const dates = r.records.map((x) => x.date).sort();
  assert.deepEqual(dates, ['2026-09-16', '2026-09-17']);
});

test('endDate 正确过滤（只返回 <= endDate）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { endDate: '2026-09-15' }));
  const dates = r.records.map((x) => x.date);
  assert.deepEqual(dates, ['2026-09-15']);
});

// ---- 8. limit 生效 ----
test('limit 生效：只返回最近 N 条', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { limit: 2 }));
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].date, '2026-09-17');
  assert.equal(r.records[1].date, '2026-09-16');
});

// ---- 9. 超过 limit 上限被限制（上限 60） ----
test('limit 超上限被钳制到 60，绝不无限返回', async () => {
  const many = [];
  for (let i = 0; i < 65; i++) {
    const d = new Date(2026, 0, 1); d.setDate(d.getDate() + i);
    const pad = (n) => String(n).padStart(2, '0');
    many.push({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, period: true });
  }
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: many } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { limit: 9999 }));
  assert.equal(r.records.length, 60);
});

// ---- 10. 非法日期被拒绝 ----
test('非法日期被拒绝（格式错误 / 不存在的日历日期）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const bad = ['2026/09/01', 'not-a-date', '2026-13-01', '2026-02-31', '20260915'];
  for (const v of bad) {
    const r = parse(await callTool('get_menstrual_records', { startDate: v }));
    assert.equal(r.code, 'INVALID', `应拒绝非法日期 ${v}`);
  }
});

// ---- 11. startDate > endDate 被拒绝 ----
test('startDate > endDate 返回明确错误', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', { startDate: '2026-09-20', endDate: '2026-09-10' }));
  assert.equal(r.code, 'INVALID');
  assert.ok(r.error.includes('startDate'));
});

// ---- 12. READ 允许 → 成功 ----
test('Permission READ allowed 时读取成功', () => {
  assert.equal(aiCan('menstrual', 'read'), true);
});

// ---- 13. READ denied → DENIED ----
test('Permission READ denied 时返回 DENIED（不改数据）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const saved = AI_PERMISSION_POLICY.menstrual;
  AI_PERMISSION_POLICY.menstrual = { read: false, create: false, write: false, delete: false };
  try {
    const r = parse(await callTool('get_menstrual_records', {}));
    assert.equal(r.code, 'DENIED');
  } finally {
    AI_PERMISSION_POLICY.menstrual = saved;
  }
});

// ---- 14/15/16. AI 不允许 CREATE/WRITE/DELETE 经期 ----
test('AI 对经期：CREATE/WRITE/DELETE 全部拒绝，仅 READ 允许', () => {
  assert.equal(aiCan('menstrual', 'read'), true);
  assert.equal(aiCan('menstrual', 'create'), false);
  assert.equal(aiCan('menstrual', 'write'), false);
  assert.equal(aiCan('menstrual', 'update'), false); // update 映射 write
  assert.equal(aiCan('menstrual', 'delete'), false);
});

// ---- 17/18. 现有写工具对 AI 调用被拒绝 ----
test('add_period_start 对 AI 调用被拒绝（DENIED，不落库）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualCycles: [] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('add_period_start', { date: '2026-09-18' }));
  assert.equal(r.code, 'DENIED');
  const state = await getState(user.id);
  assert.equal(state.menstrualCycles.length, 0); // 未写入
});

test('add_period_end 对 AI 调用被拒绝（DENIED，不落库）', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { menstrualCycles: [{ id: 'c1', startDate: '2026-09-15', endDate: null, durationDays: null, cycleLengthDays: null, createdAt: 1, updatedAt: 1 }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('add_period_end', { date: '2026-09-20' }));
  assert.equal(r.code, 'DENIED');
  const state = await getState(user.id);
  assert.equal(state.menstrualCycles[0].endDate, null); // 未关闭
});

// ---- 19. 不调用任何 AI provider（无 DeepSeek 调用） ----
test('读取是纯本地操作，绝不发起网络/DeepSeek 调用', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualDays: DAYS } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const orig = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('不应调用网络'); };
  try {
    const r = parse(await callTool('get_menstrual_records', {}));
    assert.equal(r.code, 'OK');
    assert.equal(fetchCalls, 0, '读取经期不得触发任何 provider 请求');
  } finally {
    global.fetch = orig;
  }
});

// ---- 20. 不支持 Tool Calling 的模型不 fallback ----
test('未知/不支持 Tool Calling 的模型诚实返回 false，绝不静默 fallback', () => {
  assert.equal(supportsToolCalling('some-custom-model'), false);
  assert.equal(supportsToolCalling('deepseek-chat'), true);
  assert.equal(supportsToolCalling('claude-sonnet-5'), true);
});

// ---- 21/22. 不影响既有周期/预测工具 ----
test('不影响 get_menstrual_cycles（仍 READ 成功）', async () => {
  const user = await createUser({
    email: null, passwordHash: null,
    state: { menstrualCycles: [{ id: 'c1', startDate: '2026-09-01', endDate: '2026-09-05', durationDays: 5, cycleLengthDays: null, createdAt: 1, updatedAt: 1 }] },
  });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_cycles', {}));
  assert.equal(r.code, 'OK');
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].startDate, '2026-09-01');
});

test('不影响 get_period_prediction（仍 READ 成功）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: { menstrualCycles: [] } });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_period_prediction', {}));
  assert.equal(r.code, 'OK');
  assert.ok(r.prediction, '返回预测对象');
});

// ---- 23. 不影响用户前端正常记录经期（用户路径不走 AI 权限） ----
test('用户前端经期记录（startCycle/endCycle/upsertMenstrualDay）不受 AI 权限变更影响', () => {
  // 收紧 AI 权限后，用户自己记录周期仍走 startCycle/endCycle 纯逻辑，照常可用
  const cycles = [];
  const { cycle, created } = startCycle(cycles, '2026-09-01');
  assert.equal(created, true);
  cycles.push({ ...cycle, id: 'c1' });
  const { closed } = endCycle(cycles, '2026-09-05');
  assert.equal(closed, true);
  assert.equal(cycles[0].endDate, '2026-09-05');

  // 用户逐日记录仍走 upsertMenstrualDay（前端 DB 保存），照常可用
  let days = upsertMenstrualDay([], '2026-09-15', { period: true, flow: '中' });
  days = upsertMenstrualDay(days, '2026-09-15', { symptoms: ['腹痛'] });
  assert.equal(days.length, 1);
  assert.equal(days[0].flow, '中');
  assert.deepEqual(days[0].symptoms, ['腹痛']);
});

// ---- 24. 空记录稳定返回空结果，不报错 ----
test('menstrualDays 为空时返回稳定空结果（非报错）', async () => {
  const user = await createUser({ email: null, passwordHash: null, state: {} });
  const { callTool } = buildDomainTools(user.id, 'test-model');
  const r = parse(await callTool('get_menstrual_records', {}));
  assert.equal(r.code, 'OK');
  assert.deepEqual(r.records, []);
  assert.equal(r.source, 'menstrualDays');
  assert.equal(r.isPrediction, false);
  assert.equal(r.count, 0);
});
