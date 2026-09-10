import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yuanToCents, centsToYuan, fmtCents,
  parseAmountCents, parseQuantity, parseExpenseText, parsePurchaseText,
  guessCategory, monthKey, daysRemainingInMonth, financeSummary,
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
