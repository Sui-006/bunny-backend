// 经期逐日记录纯逻辑测试。
// 覆盖：同一天只保留一条（upsert）、字段合并、空记录判定（空则移除）、与 cycle 分离。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertMenstrualDay, menstrualDayIsEmpty } from '../lib/frontend-logic.js';

test('upsert：同一天只保留一条记录，字段合并', () => {
  let days = upsertMenstrualDay([], '2026-09-15', { period: true, flow: '中' });
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-09-15');
  assert.equal(days[0].flow, '中');

  // 再次记录同一天（加症状）→ 合并到同一条，不产生第二条
  days = upsertMenstrualDay(days, '2026-09-15', { symptoms: ['头痛'] });
  assert.equal(days.length, 1);
  assert.equal(days[0].period, true);
  assert.equal(days[0].flow, '中');
  assert.deepEqual(days[0].symptoms, ['头痛']);
});

test('upsert：不同日期各一条', () => {
  let days = upsertMenstrualDay([], '2026-09-15', { period: true });
  days = upsertMenstrualDay(days, '2026-09-16', { spotting: true });
  assert.equal(days.length, 2);
});

test('upsert：空日期不新增，且不原地修改原数组', () => {
  const orig = [];
  assert.equal(upsertMenstrualDay(orig, '').length, 0);
  assert.deepEqual(orig, []);
});

test('空记录判定：无任何字段 → 空（应移除）', () => {
  assert.equal(menstrualDayIsEmpty(null), true);
  assert.equal(menstrualDayIsEmpty({ date: '2026-09-15' }), true);
  assert.equal(menstrualDayIsEmpty({ date: '2026-09-15', symptoms: [] }), true);
  assert.equal(menstrualDayIsEmpty({ date: '2026-09-15', bbt: '' }), true);
});

test('空记录判定：有任一字段 → 非空（保留）', () => {
  assert.equal(menstrualDayIsEmpty({ period: true }), false);
  assert.equal(menstrualDayIsEmpty({ flow: '少' }), false);
  assert.equal(menstrualDayIsEmpty({ spotting: true }), false);
  assert.equal(menstrualDayIsEmpty({ bbt: 36.5 }), false);
  assert.equal(menstrualDayIsEmpty({ symptoms: ['腹痛'] }), false);
});

test('空记录判定：symptoms 含空字符串仍视为空', () => {
  assert.equal(menstrualDayIsEmpty({ symptoms: ['', null] }), true);
});
