// 经期记录与预测。
// 记录结构：{ id, startDate, endDate(null=进行中), durationDays, cycleLengthDays, createdAt, updatedAt }
// 预测只基于真实历史（最近若干完整周期的开始间隔、持续时长、波动），
// 数据不足或波动过大时明确降级，绝不编造精确日期；预测不构成医学诊断。

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dstr(new Date());

export function parseDate(s) {
  const p = String(s || '').split('-').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}

export function addDays(s, n) {
  const d = parseDate(s) || new Date();
  d.setDate(d.getDate() + n);
  return dstr(d);
}

// 两个日期相差天数（b - a，可为负）
export function diffDays(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

// 按开始日期升序
export function sortCycles(cycles) {
  return (cycles || []).slice().sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
}

// 用相邻两次开始日期的间隔回填 cycleLengthDays（最近一次无下次，保留为空）
export function withCycleLengths(cycles) {
  const sorted = sortCycles(cycles);
  return sorted.map((c, i) => {
    const next = sorted[i + 1];
    const cycleLengthDays = next ? diffDays(c.startDate, next.startDate) : (c.cycleLengthDays || null);
    return { ...c, cycleLengthDays };
  });
}

// 开始经期：若已存在未结束的周期则不重复创建，返回该进行中周期
export function startCycle(cycles, startDate) {
  const sorted = sortCycles(cycles);
  const open = sorted.find((c) => !c.endDate);
  if (open) return { cycle: open, created: false };
  const cycle = { id: undefined, startDate, endDate: null, durationDays: null, cycleLengthDays: null, createdAt: Date.now(), updatedAt: Date.now() };
  return { cycle, created: true };
}

// 结束经期：关闭最近一次未结束的周期并计算持续天数
export function endCycle(cycles, endDate) {
  const sorted = sortCycles(cycles);
  const open = sorted.filter((c) => !c.endDate).sort((a, b) => (a.startDate > b.startDate ? -1 : 1))[0];
  if (!open) return { cycle: null, closed: false };
  const durationDays = Math.max(1, diffDays(open.startDate, endDate) + 1);
  open.endDate = endDate;
  open.durationDays = durationDays;
  open.updatedAt = Date.now();
  return { cycle: open, closed: true };
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

/**
 * 预测下一次经期。
 * @param cycles 原始周期记录
 * @param today 今天（YYYY-MM-DD），用于判断"最近一次是否已过期"
 */
export function predict(cycles, today = todayStr()) {
  const sorted = sortCycles(cycles).filter((c) => c.startDate);
  if (sorted.length === 0) {
    return { status: 'insufficient', note: '还没有记录过经期，暂时无法预测。', confidence: null };
  }

  const lastStart = sorted[sorted.length - 1].startDate;
  const lastCycle = sorted[sorted.length - 1];
  const lastEnd = lastCycle.endDate || null;

  // 相邻开始间隔 → 周期长度
  const lengths = [];
  for (let i = 1; i < sorted.length; i++) lengths.push(diffDays(sorted[i - 1].startDate, sorted[i].startDate));
  // 持续时长
  const durations = sorted.filter((c) => c.durationDays).map((c) => c.durationDays);

  const averageDurationDays = durations.length ? round1(mean(durations)) : null;
  const averageCycleLengthDays = lengths.length ? round1(mean(lengths)) : null;
  const cycleVarianceDays = round1(stddev(lengths));

  if (lengths.length === 0) {
    // 只有一次开始日期：不足以估算周期
    return {
      status: 'insufficient',
      lastStart, lastEnd,
      averageCycleLengthDays: null, averageDurationDays, cycleVarianceDays: 0,
      predictedStart: null, predictedEnd: null, rangeStart: null, rangeEnd: null,
      confidence: null,
      note: '目前记录还不够，我会继续根据之后的记录逐渐估算你的周期。',
    };
  }

  const predictedStart = addDays(lastStart, Math.round(mean(lengths)));
  const predictedEnd = averageDurationDays ? addDays(predictedStart, Math.round(averageDurationDays) - 1) : predictedStart;
  // 预测范围：取周期波动（±1 个标准差，至少 ±2 天）
  const spread = Math.max(2, Math.round(cycleVarianceDays || 2));
  const rangeStart = addDays(predictedStart, -spread);
  const rangeEnd = addDays(predictedStart, spread);

  let confidence = 'medium';
  let note = '预测仅供参考。';
  if (cycleVarianceDays >= 5 || (lengths.length && (Math.max(...lengths) - Math.min(...lengths)) >= 10)) {
    confidence = 'low';
    note = '你的周期目前波动较大，因此预测范围会比较宽。';
  } else if (lengths.length >= 2 && cycleVarianceDays < 3) {
    confidence = 'high';
    note = '根据最近几次周期估算，预测仅供参考。';
  }

  return {
    status: 'ready',
    lastStart, lastEnd,
    cycleLengths: lengths, durations,
    averageCycleLengthDays, averageDurationDays, cycleVarianceDays,
    predictedStart, predictedEnd, rangeStart, rangeEnd,
    confidence,
    note,
  };
}

// 某日期落在哪个"经期状态"：start=经期开始日 / end=经期结束日 / in=经期中 / predicted=预测范围
export function dayStatus(cycles, prediction, date) {
  const sorted = sortCycles(cycles);
  for (const c of sorted) {
    if (c.startDate === date) return 'start';
    if (c.endDate === date) return 'end';
    if (c.startDate < date && c.endDate && c.endDate > date) return 'in';
    if (c.startDate < date && !c.endDate) return 'in';
  }
  if (prediction && prediction.status === 'ready') {
    if (date >= prediction.rangeStart && date <= prediction.rangeEnd) return 'predicted';
  }
  return null;
}
