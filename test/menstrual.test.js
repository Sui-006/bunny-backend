import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffDays, startCycle, endCycle, withCycleLengths, predict, dayStatus,
} from '../lib/menstrual.js';

function cyc(startDate, endDate, durationDays) {
  return { id: startDate, startDate, endDate, durationDays, cycleLengthDays: null };
}

test('开始/结束经期：持续天数 = 结束 - 开始 + 1', () => {
  const cycles = [];
  const { cycle, created } = startCycle(cycles, '2026-06-01');
  assert.equal(created, true);
  assert.equal(cycle.endDate, null);
  cycles.push(cycle);

  const again = startCycle(cycles, '2026-06-02');
  assert.equal(again.created, false); // 已有进行中，不重复创建

  const { cycle: closed, closed: isClosed } = endCycle(cycles, '2026-06-05');
  assert.equal(isClosed, true);
  assert.equal(closed.endDate, '2026-06-05');
  assert.equal(closed.durationDays, 5);
});

test('diffDays / withCycleLengths：周期间隔', () => {
  assert.equal(diffDays('2026-06-01', '2026-06-29'), 28);
  const cycles = [cyc('2026-06-01', '2026-06-05', 5), cyc('2026-06-29', '2026-07-03', 5), cyc('2026-07-27', '2026-07-31', 5)];
  const out = withCycleLengths(cycles);
  assert.equal(out[0].cycleLengthDays, 28);
  assert.equal(out[1].cycleLengthDays, 28);
  assert.equal(out[2].cycleLengthDays, null); // 最近一次无下次
});

test('predict：历史数据不足（0 条 / 仅 1 次开始）', () => {
  let p = predict([]);
  assert.equal(p.status, 'insufficient');
  assert.equal(p.predictedStart, null);

  p = predict([cyc('2026-08-24', null, null)]);
  assert.equal(p.status, 'insufficient');
  assert.ok(p.note.includes('记录还不够'));
});

test('predict：规律周期 → 预计日期 + 范围 + 高可信度', () => {
  const cycles = [
    cyc('2026-06-01', '2026-06-05', 5),
    cyc('2026-06-29', '2026-07-03', 5),
    cyc('2026-07-27', '2026-07-31', 5),
    cyc('2026-08-24', '2026-08-28', 5),
  ];
  const p = predict(cycles, '2026-09-01');
  assert.equal(p.status, 'ready');
  assert.equal(p.averageCycleLengthDays, 28);
  assert.equal(p.averageDurationDays, 5);
  assert.equal(p.predictedStart, '2026-09-21'); // 08-24 + 28
  assert.equal(p.predictedEnd, '2026-09-25'); // 09-21 + 5 - 1
  assert.equal(p.rangeStart, '2026-09-19');
  assert.equal(p.rangeEnd, '2026-09-23');
  assert.equal(p.confidence, 'high');
});

test('predict：周期波动大 → 低可信度 + 宽范围提示', () => {
  const cycles = [
    cyc('2026-06-01', '2026-06-05', 5),
    cyc('2026-06-10', '2026-06-14', 5), // 9
    cyc('2026-07-20', '2026-07-25', 6), // 40
    cyc('2026-08-05', '2026-08-10', 6), // 16
  ];
  const p = predict(cycles, '2026-09-01');
  assert.equal(p.status, 'ready');
  assert.equal(p.confidence, 'low');
  assert.ok(p.note.includes('波动较大'));
});

test('dayStatus：start/end/in/predicted', () => {
  const cycles = [cyc('2026-08-24', '2026-08-28', 5)];
  const p = predict(cycles, '2026-09-01');
  assert.equal(dayStatus(cycles, p, '2026-08-24'), 'start');
  assert.equal(dayStatus(cycles, p, '2026-08-28'), 'end');
  assert.equal(dayStatus(cycles, p, '2026-08-26'), 'in');
  assert.equal(dayStatus(cycles, p, p.predictedStart), 'predicted');
  assert.equal(dayStatus(cycles, p, '2026-10-01'), null);
});
