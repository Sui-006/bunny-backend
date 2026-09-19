// 月度任务（打卡 / 进度 / 颜色点）纯逻辑测试。
// 覆盖：进度真实数据（绝不画死）、打卡幂等（同一天不无限增加）、
//       颜色点来自真实 check-ins、多任务同一天多个点、target 边界封顶。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyTaskProgress, monthlyTaskCheckin, monthlyTaskCheckedOn, monthlyTaskCheckinsByDate,
} from '../lib/frontend-logic.js';
import { planProgress, monthlyTaskProgress as domainMonthlyTaskProgress } from '../lib/domain.js';

test('进度是真实数据：checkIns.length / target，而不是写死的 60%', () => {
  const task = { id: 't1', name: '学完第一章', target: 10, checkIns: Array.from({ length: 6 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`) };
  assert.equal(monthlyTaskProgress(task), 60);
});

test('进度 0%：没有任何打卡', () => {
  assert.equal(monthlyTaskProgress({ target: 30, checkIns: [] }), 0);
});

test('进度封顶 100%：打卡数超过 target 不无限增长', () => {
  const task = { target: 3, checkIns: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'] };
  assert.equal(monthlyTaskProgress(task), 100);
});

test('target 未设置/为 0：视为 1（一次打卡即完成）', () => {
  assert.equal(monthlyTaskProgress({ checkIns: [] }), 0);
  assert.equal(monthlyTaskProgress({ checkIns: ['2026-09-01'] }), 100);
});

test('打卡幂等：同一任务同一天重复点击不新增', () => {
  const task = { id: 't1', checkIns: ['2026-09-15'] };
  const first = monthlyTaskCheckin(task, '2026-09-15');
  assert.equal(first.changed, false);
  assert.deepEqual(first.checkIns, ['2026-09-15']);

  const second = monthlyTaskCheckin({ id: 't1', checkIns: first.checkIns }, '2026-09-15');
  assert.equal(second.changed, false);
  assert.deepEqual(second.checkIns, ['2026-09-15']);
});

test('打卡：新日期才新增，且不原地修改 task', () => {
  const task = { id: 't1', checkIns: ['2026-09-15'] };
  const r = monthlyTaskCheckin(task, '2026-09-16');
  assert.equal(r.changed, true);
  assert.deepEqual(r.checkIns, ['2026-09-15', '2026-09-16']);
  assert.deepEqual(task.checkIns, ['2026-09-15']); // 原对象未被改动
});

test('空日期打卡：不新增', () => {
  assert.equal(monthlyTaskCheckin({ checkIns: [] }, '').changed, false);
  assert.equal(monthlyTaskCheckin({ checkIns: [] }, null).changed, false);
});

test('颜色点：某日该任务是否已打卡（复用 checkIns，不另造完成日期）', () => {
  const task = { id: 't1', checkIns: ['2026-09-15'] };
  assert.equal(monthlyTaskCheckedOn(task, '2026-09-15'), true);
  assert.equal(monthlyTaskCheckedOn(task, '2026-09-16'), false);
  assert.equal(monthlyTaskCheckedOn(task, ''), false);
});

test('多任务同一天多个点：按日期聚合任务 id', () => {
  const tasks = [
    { id: 'a', color: '#10b981', checkIns: ['2026-09-15', '2026-09-16'] },
    { id: 'b', color: '#8b5cf6', checkIns: ['2026-09-15'] },
    { id: 'c', color: '#6b8cae', checkIns: ['2026-09-17'] },
  ];
  const byDate = monthlyTaskCheckinsByDate(tasks);
  assert.deepEqual(byDate['2026-09-15'], ['a', 'b']);
  assert.deepEqual(byDate['2026-09-16'], ['a']);
  assert.deepEqual(byDate['2026-09-17'], ['c']);
  assert.equal(byDate['2026-09-18'], undefined);
});

test('空任务列表 / 空 check-ins：聚合不抛异常且为空', () => {
  assert.deepEqual(monthlyTaskCheckinsByDate([]), {});
  assert.deepEqual(monthlyTaskCheckinsByDate([{ id: 'x', checkIns: [] }]), {});
});

test('domain.monthlyTaskProgress 与前端口径一致', () => {
  const task = { target: 10, checkIns: Array.from({ length: 6 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`) };
  assert.equal(domainMonthlyTaskProgress(task), 60);
  assert.equal(domainMonthlyTaskProgress({ target: 3, checkIns: ['a', 'b', 'c', 'd'] }), 100);
});

test('planProgress：月度计划用月度任务打卡进度（真实数据）', () => {
  const plan = { type: 'monthly', monthlyTasks: [
    { id: 'a', name: '学完第一章', target: 10, checkIns: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'] },
    { id: 'b', name: '每天学习', target: 30, checkIns: ['2026-09-01', '2026-09-02', '2026-09-03'] },
  ] };
  // (60 + 10) / 2 = 35
  assert.equal(planProgress(plan), 35);
});

test('planProgress：月度计划无任务 → 0；阶段/长期仍按 stageGoals', () => {
  assert.equal(planProgress({ type: 'monthly', monthlyTasks: [] }), 0);
  const stage = { type: 'stage', stageGoals: [{ progress: 50 }, { progress: 100 }] };
  assert.equal(planProgress(stage), 75);
});
