// 回归测试：后端时间系统统一 —— todayStr（上海墙钟）与 currentTimeInfo 同源。
// 覆盖：todayStr 与 currentTimeInfo 同源、跨上海午夜边界、服务器时区无关、currentTimeInfo 字段语义不回归、各调用方可加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTimeInfo, todayStr } from '../lib/time.js';

// Test 1：todayStr 与 currentTimeInfo 同源（固定绝对时刻）
test('todayStr 与 currentTimeInfo 同源：UTC 23:59:59 → 上海已次日', () => {
  const now = new Date('2026-01-01T23:59:59Z');
  assert.equal(todayStr(now), '2026-01-02');
  assert.equal(currentTimeInfo(now).localDate, '2026-01-02');
  assert.equal(todayStr(now), currentTimeInfo(now).localDate);
});

// Test 2：跨上海午夜（最关键边界）
test('跨上海午夜：UTC 15:59:59 → 上海 23:59:59，仍是 01-01', () => {
  assert.equal(todayStr(new Date('2026-01-01T15:59:59Z')), '2026-01-01');
});

test('跨上海午夜：UTC 16:00:00 → 上海 00:00:00，进入 01-02', () => {
  assert.equal(todayStr(new Date('2026-01-01T16:00:00Z')), '2026-01-02');
});

// Test 3：服务器时区无关（固定 instant，结果与机器时区无关）
test('服务器时区无关：同一 instant 恒为上海日期，currentTime 保持真实 UTC', () => {
  const instant = '2026-01-01T16:00:00Z';
  assert.equal(todayStr(new Date(instant)), '2026-01-02');
  // currentTime 必须仍是真实 UTC instant，不被 +8h 平移伪造（toISOString 恒含毫秒）
  assert.equal(currentTimeInfo(new Date(instant)).currentTime, new Date(instant).toISOString());
});

// Test 4：currentTimeInfo 字段语义不回归（沿用既有断言）
test('currentTimeInfo 字段语义不回归', () => {
  const t = currentTimeInfo(new Date('2026-09-18T00:00:00Z'));
  assert.equal(t.timezone, 'Asia/Shanghai');
  assert.equal(t.localDate, '2026-09-18');
  assert.equal(t.localTime, '08:00:00'); // UTC+8
  assert.ok(typeof t.weekday === 'string' && t.weekday.length > 0);
  assert.equal(t.currentTime, '2026-09-18T00:00:00.000Z'); // 真实 UTC instant
});

// Test 5：调用方兼容（各模块可加载、re-export 为同一函数引用）
test('各 todayStr 调用方仍能加载，且 finance/menstrual re-export 同一实现', async () => {
  const finance = await import('../lib/finance.js');
  const menstrual = await import('../lib/menstrual.js');
  assert.equal(typeof finance.todayStr, 'function');
  assert.equal(typeof menstrual.todayStr, 'function');
  assert.equal(finance.todayStr, todayStr);   // 同一函数引用 → 唯一实现
  assert.equal(menstrual.todayStr, todayStr); // 同一函数引用 → 唯一实现

  // 各业务模块正常加载（不出现 todayStr is not defined / Cannot find export）
  await import('../lib/domain.js');
  await import('../routes/tasks.js');
  await import('../routes/health.js');
  await import('../routes/statistics.js');
  await import('../routes/habits.js');
  await import('../routes/proactive.js');
  await import('../routes/notifications.js');
});
