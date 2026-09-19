import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yuanToCents, centsToYuan, fmtCents,
  parseAmountCents, parseQuantity, parseExpenseText, parsePurchaseText,
  guessCategory, monthKey, daysRemainingInMonth, financeSummary,
  compareExpenseDesc, sortExpensesDesc, comparePurchasesDesc, sortPurchasesDesc,
} from '../lib/finance.js';

test('金额：整数分存储，杜绝浮点误差（CNY）', () => {
  assert.equal(yuanToCents(38), 3800);
  assert.equal(yuanToCents('0.5'), 50);
  assert.equal(yuanToCents('38.55'), 3855);
  assert.equal(yuanToCents(0.1 + 0.2), 30); // 0.30000000000000004 → 30 分
  assert.equal(centsToYuan(3800), 38);
  assert.equal(centsToYuan(3855), 38.55);
  assert.equal(fmtCents(3800), '￥38');
  assert.equal(fmtCents(3850), '￥38.5');
  assert.equal(fmtCents(3855), '￥38.55');
});

test('parseAmountCents：币种符号 / 末尾数字', () => {
  assert.equal(parseAmountCents('￥38'), 3800);
  assert.equal(parseAmountCents('38元'), 3800);
  assert.equal(parseAmountCents('25块'), 2500);
  assert.equal(parseAmountCents('25块钱'), 2500);
  assert.equal(parseAmountCents('打车18'), 1800);
  assert.equal(parseAmountCents('38.5元'), 3850);
  assert.equal(parseAmountCents('没有金额'), null);
});

test('parseQuantity：×1 / 2把 / *3 / 默认1', () => {
  assert.equal(parseQuantity('雨伞 ×1 ￥38'), 1);
  assert.equal(parseQuantity('雨伞 2把 38元'), 2);
  assert.equal(parseQuantity('苹果 *3 ￥10'), 3);
  assert.equal(parseQuantity('雨伞 38元'), 1);
});

test('parseExpenseText：标题 / 分类 / 金额', () => {
  let e = parseExpenseText('麻辣烫 吃饭 ￥20');
  assert.equal(e.title, '麻辣烫');
  assert.equal(e.category, '吃饭');
  assert.equal(e.amountCents, 2000);
  assert.equal(e.currency, 'CNY');

  e = parseExpenseText('打车18');
  assert.equal(e.category, '交通');
  assert.equal(e.amountCents, 1800);

  e = parseExpenseText('买了一包薯片8块');
  assert.equal(e.category, '零食');
  assert.equal(e.amountCents, 800);
});

test('parsePurchaseText：数量 × 单价 = 总价', () => {
  let p = parsePurchaseText('雨伞 ×1 ￥38');
  assert.equal(p.itemName, '雨伞');
  assert.equal(p.quantity, 1);
  assert.equal(p.unitPriceCents, 3800);
  assert.equal(p.totalAmountCents, 3800);

  p = parsePurchaseText('雨伞 2把 38元');
  assert.equal(p.quantity, 2);
  assert.equal(p.unitPriceCents, 3800);
  assert.equal(p.totalAmountCents, 7600);
  assert.equal(p.currency, 'CNY');
});

test('guessCategory：语义分类', () => {
  assert.equal(guessCategory('兰州拉面'), '吃饭');
  assert.equal(guessCategory('薯片'), '零食');
  assert.equal(guessCategory('打车'), '交通');
  assert.equal(guessCategory('雨伞'), '生活用品');
  assert.equal(guessCategory('钢笔'), '学习');
  assert.equal(guessCategory('神秘物品'), '其他');
});

test('monthKey / daysRemainingInMonth：月初月末跨月', () => {
  assert.equal(monthKey('2026-09-15'), '2026-09');
  assert.equal(daysRemainingInMonth('2026-01-15'), 16); // 31 - 15
  assert.equal(daysRemainingInMonth('2026-02-10'), 18); // 28 - 10
  assert.equal(daysRemainingInMonth('2026-02-28'), 0);
});

test('financeSummary：月预算 / 已花 / 剩余 / 每日建议 / 分类统计', () => {
  const doc = {
    budget: { monthlyCents: 300000 }, // ￥3000
    expenses: [
      { title: '麻辣烫', category: '吃饭', amountCents: 2000, occurredAt: '2026-09-10' },
      { title: '薯片', category: '零食', amountCents: 800, occurredAt: '2026-09-15' },
      { title: '买书', category: '学习', amountCents: 5000, occurredAt: '2026-09-12' },
      { title: '打车', category: '交通', amountCents: 1800, occurredAt: '2026-08-20' }, // 上月，不计入本月
    ],
    purchases: [
      { itemName: '雨伞', quantity: 1, unitPriceCents: 3800, totalAmountCents: 3800, purchasedAt: '2026-09-11', category: '生活用品' },
    ],
  };
  const s = financeSummary(doc, '2026-09-15');
  assert.equal(s.monthExpenseCents, 7800); // 2000+800+5000
  assert.equal(s.remainingCents, 292200); // 300000 - 7800
  assert.equal(s.remainingDays, 15);
  assert.equal(s.recommendedDailyBudgetCents, 19480); // 292200/15
  assert.equal(s.todayExpenseCents, 800); // 薯片 today
  assert.equal(s.categoryBreakdown['吃饭'], 2000);
  assert.equal(s.categoryBreakdown['学习'], 5000);
  assert.equal(s.monthExpenseCount, 3);
  assert.equal(s.recentPurchases.length, 1);
  assert.equal(s.hasBudget, true);
});

test('financeSummary：未设预算', () => {
  const doc = { budget: { monthlyCents: null }, expenses: [], purchases: [] };
  const s = financeSummary(doc, '2026-09-15');
  assert.equal(s.hasBudget, false);
  assert.equal(s.monthlyBudgetCents, 0);
  assert.equal(s.remainingCents, 0);
});

// ---- 排序（本次需求：所有账单按真实账单时间倒序，最新在最上面）----
test('排序 1：多条不同日期倒序，最新在最上面', () => {
  const list = [
    { id: 'a', occurredAt: '2026-09-01' },
    { id: 'b', occurredAt: '2026-09-15' },
    { id: 'c', occurredAt: '2026-09-10' },
  ];
  assert.deepEqual(sortExpensesDesc(list).map((e) => e.id), ['b', 'c', 'a']);
});

test('排序 2：新建账单立即在顶部（createdAt 最新）', () => {
  // 同一天，无 occurredTime：按 createdAt 倒序 → 最新创建在最上面
  const list = [
    { id: 'old', occurredAt: '2026-09-15', createdAt: 1000 },
    { id: 'new', occurredAt: '2026-09-15', createdAt: 3000 },
    { id: 'mid', occurredAt: '2026-09-15', createdAt: 2000 },
  ];
  assert.deepEqual(sortExpensesDesc(list).map((e) => e.id), ['new', 'mid', 'old']);
});

test('排序 3：occurredTime 倒序（同日按真实发生时间）', () => {
  const list = [
    { id: 'morning', occurredAt: '2026-09-15', occurredTime: '08:30' },
    { id: 'night', occurredAt: '2026-09-15', occurredTime: '23:10' },
    { id: 'noon', occurredAt: '2026-09-15', occurredTime: '12:00' },
  ];
  assert.deepEqual(sortExpensesDesc(list).map((e) => e.id), ['night', 'noon', 'morning']);
});

test('排序 4：同时间稳定（occurredAt/occurredTime/createdAt 全同，按 id 稳定）', () => {
  const list = [
    { id: 'c', occurredAt: '2026-09-15', occurredTime: '12:00', createdAt: 1000 },
    { id: 'a', occurredAt: '2026-09-15', occurredTime: '12:00', createdAt: 1000 },
    { id: 'b', occurredAt: '2026-09-15', occurredTime: '12:00', createdAt: 1000 },
  ];
  // 比较器是对称/传递的：同键时按 id 升序稳定，多次排序结果一致
  const once = sortExpensesDesc(list).map((e) => e.id);
  const twice = sortExpensesDesc(sortExpensesDesc(list)).map((e) => e.id);
  assert.deepEqual(once, ['a', 'b', 'c']);
  assert.deepEqual(twice, once); // 幂等稳定
});

test('排序 5：编辑金额/分类/备注不改变位置（只改 updatedAt）', () => {
  const list = [
    { id: 'a', occurredAt: '2026-09-15', createdAt: 1000, amountCents: 100 },
    { id: 'b', occurredAt: '2026-09-15', createdAt: 2000, amountCents: 100 },
  ];
  // 修改金额 / 分类 / 备注 → 只改 updatedAt / 其它字段，排序键（occurredAt/occurredTime/createdAt）不变
  const edited = [
    { ...list[0], amountCents: 999999, category: '吃饭', note: '改了备注', updatedAt: 9999 },
    { ...list[1], amountCents: 1, category: '学习', note: 'x', updatedAt: 9999 },
  ];
  // 原始顺序 b 在前（createdAt 大），编辑后顺序不变
  assert.deepEqual(sortExpensesDesc(edited).map((e) => e.id), ['b', 'a']);
});

test('排序 6：修改账单日期后正确重排', () => {
  const list = [
    { id: 'a', occurredAt: '2026-09-01', createdAt: 1000 },
    { id: 'b', occurredAt: '2026-09-15', createdAt: 2000 },
    { id: 'c', occurredAt: '2026-09-10', createdAt: 3000 },
  ];
  assert.deepEqual(sortExpensesDesc(list).map((e) => e.id), ['b', 'c', 'a']);
  // 把 b 的日期改成 09-05（早于 c 的 09-10），应重排：c 顶、b 在 c 后
  const changed = [{ ...list[0] }, { ...list[1], occurredAt: '2026-09-05' }, { ...list[2] }];
  assert.deepEqual(sortExpensesDesc(changed).map((e) => e.id), ['c', 'b', 'a']);
});

test('排序 7：compareExpenseDesc 空日期/空时间不抛异常且一致', () => {
  const a = { id: 'x', occurredAt: '' };
  const b = { id: 'y', occurredAt: '2026-09-15' };
  assert.equal(compareExpenseDesc(a, b), 1); // 空日期排最后
  assert.equal(compareExpenseDesc(b, a), -1);
  assert.equal(compareExpenseDesc(a, a), 0);
});

test('排序 8：purchases 按 purchasedAt 倒序，同日期按 createdAt 稳定', () => {
  const list = [
    { id: 'p1', purchasedAt: '2026-09-01', createdAt: 100 },
    { id: 'p3', purchasedAt: '2026-09-15', createdAt: 300 },
    { id: 'p2', purchasedAt: '2026-09-15', createdAt: 200 },
  ];
  assert.deepEqual(sortPurchasesDesc(list).map((p) => p.id), ['p3', 'p2', 'p1']);
  assert.equal(comparePurchasesDesc({ purchasedAt: '' }, { purchasedAt: '2026-09-01' }), 1);
});
