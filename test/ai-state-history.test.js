// 回归测试：AI 心情历史分桶（Bug 3 修复验证）。
// 覆盖：今天全部 / 本周（今天以前，周一起算）/ 更早（本周以前）三桶互不重叠；
//       跨周边界正确（绝不把上周日算进「本周」，也绝不用「最近 7 天」滚动窗口）；
//       跨月/跨年、周一周日边界、桶内最新在前、空数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketAiStates } from '../lib/frontend-logic.js';

// 本地日历日构造（与前端 new Date 同法，机器时区无关）
const t = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

// 固定「现在」= 2026-09-19（周六）12:00。本周周一 = 2026-09-14。
const NOW = t(2026, 9, 19, 12);

test('今天：全部进 todayItems（含多条），且最新在前', () => {
  const states = [
    { id: 'a', createdAt: t(2026, 9, 19, 8) },
    { id: 'b', createdAt: t(2026, 9, 19, 20) },
    { id: 'c', createdAt: t(2026, 9, 19, 1) },
  ];
  const { todayItems, weekItems, earlierItems } = bucketAiStates(states, NOW);
  assert.deepEqual(todayItems.map((s) => s.id), ['b', 'a', 'c']); // 最新在前
  assert.equal(weekItems.length, 0);
  assert.equal(earlierItems.length, 0);
});

test('本周（今天以前）：周一~周五的记录归入本周', () => {
  const states = [
    { id: 'mon', createdAt: t(2026, 9, 14) }, // 周一
    { id: 'fri', createdAt: t(2026, 9, 18) }, // 周五
    { id: 'wed', createdAt: t(2026, 9, 16) }, // 周三
  ];
  const { weekItems, todayItems, earlierItems } = bucketAiStates(states, NOW);
  assert.deepEqual(weekItems.map((s) => s.id), ['fri', 'wed', 'mon']); // 最新在前
  assert.equal(todayItems.length, 0);
  assert.equal(earlierItems.length, 0);
});

test('跨周边界：上周日（09-13）归入更早，绝不因「7 天内」混进本周', () => {
  // 09-13 距 09-19 只有 6 天，若按「最近 7 天」会误判进本周；按自然周必须进「更早」。
  const states = [
    { id: 'lastSunday', createdAt: t(2026, 9, 13, 23) },
    { id: 'thisMonday', createdAt: t(2026, 9, 14, 0) },
  ];
  const { todayItems, weekItems, earlierItems } = bucketAiStates(states, NOW);
  assert.deepEqual(weekItems.map((s) => s.id), ['thisMonday']);
  assert.deepEqual(earlierItems.map((s) => s.id), ['lastSunday']);
  assert.equal(todayItems.length, 0);
});

test('更早：本周以前的任意历史（跨月/跨年）都进 earlierItems', () => {
  const states = [
    { id: 'aug', createdAt: t(2026, 8, 31) },    // 上个月
    { id: 'lastYear', createdAt: t(2025, 12, 31) }, // 跨年
    { id: 'jan', createdAt: t(2026, 1, 1) },       // 今年年初
  ];
  const { todayItems, weekItems, earlierItems } = bucketAiStates(states, NOW);
  assert.equal(todayItems.length, 0);
  assert.equal(weekItems.length, 0);
  assert.equal(earlierItems.length, 3);
});

test('周一是今天：本周（今天以前）为空，昨天归入更早', () => {
  // now = 2026-09-14 周一：本周从周一开始，今天以前没有本周记录。
  const now = t(2026, 9, 14, 12);
  const states = [
    { id: 'yesterday', createdAt: t(2026, 9, 13) }, // 上周日
    { id: 'today', createdAt: t(2026, 9, 14, 9) },
  ];
  const { todayItems, weekItems, earlierItems } = bucketAiStates(states, now);
  assert.deepEqual(todayItems.map((s) => s.id), ['today']);
  assert.equal(weekItems.length, 0); // 周一没有「本周今天以前」
  assert.deepEqual(earlierItems.map((s) => s.id), ['yesterday']);
});

test('周日是今天：本周涵盖周一~周六共 6 天', () => {
  // now = 2026-09-20 周日：本周周一 = 09-14，今天以前 = 09-14 ~ 09-19。
  const now = t(2026, 9, 20, 12);
  const states = [
    { id: 'sat', createdAt: t(2026, 9, 19) },
    { id: 'mon', createdAt: t(2026, 9, 14) },
  ];
  const { weekItems, earlierItems } = bucketAiStates(states, now);
  assert.deepEqual(weekItems.map((s) => s.id), ['sat', 'mon']);
  assert.equal(earlierItems.length, 0);
});

test('本周恰好 ≤3 条：分桶返回全部（「只显示 3 条」是 UI 切片，分桶不截断）', () => {
  const states = [
    { id: 'a', createdAt: t(2026, 9, 18) },
    { id: 'b', createdAt: t(2026, 9, 15) },
  ];
  const { weekItems } = bucketAiStates(states, NOW);
  assert.equal(weekItems.length, 2);
});

test('空 states：三桶皆空，不抛异常', () => {
  const { todayItems, weekItems, earlierItems } = bucketAiStates([], NOW);
  assert.deepEqual([todayItems, weekItems, earlierItems], [[], [], []]);
});

test('三桶互不重叠：任一状态恰好落在一桶，且总数守恒', () => {
  const states = [
    { id: 't1', createdAt: t(2026, 9, 19, 6) },
    { id: 't2', createdAt: t(2026, 9, 19, 23) },
    { id: 'w1', createdAt: t(2026, 9, 14) },
    { id: 'w2', createdAt: t(2026, 9, 18) },
    { id: 'e1', createdAt: t(2026, 9, 13) },
    { id: 'e2', createdAt: t(2026, 9, 1) },
    { id: 'e3', createdAt: t(2025, 11, 5) },
  ];
  const { todayItems, weekItems, earlierItems } = bucketAiStates(states, NOW);
  assert.equal(todayItems.length, 2);
  assert.equal(weekItems.length, 2);
  assert.equal(earlierItems.length, 3);
  assert.equal(todayItems.length + weekItems.length + earlierItems.length, states.length);
});
