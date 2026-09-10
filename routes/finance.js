// 财务：最近购买 / 记账 / 月预算 / 财务汇总。
// 金额一律整数分（amountCents / unitPriceCents / totalAmountCents / monthlyCents），货币 CNY。
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok, pick } from '../lib/rest.js';
import {
  todayStr, yuanToCents, centsToYuan,
  parseExpenseText, parsePurchaseText, guessCategory, financeSummary, EXPENSE_CATEGORIES,
} from '../lib/finance.js';

const router = Router();

const PURCHASE_FIELDS = ['itemName', 'quantity', 'unitPriceCents', 'totalAmountCents', 'currency', 'category', 'purchasedAt', 'note'];
const EXPENSE_FIELDS = ['title', 'category', 'amountCents', 'currency', 'kind', 'occurredAt', 'occurredTime', 'note'];

function normDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : todayStr(); }

// ---- 最近购买 ----
router.get('/purchases', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const list = doc.purchases.slice().sort((a, b) => (b.purchasedAt || '') < (a.purchasedAt || '') ? -1 : 1);
    ok(res, list);
  } catch (e) { next(e); }
});

router.post('/purchases', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let fields;
    if (req.body?.text) {
      const parsed = parsePurchaseText(req.body.text);
      if (!parsed) throw new HttpError(400, 'INVALID', '无法从文本解析出金额，请补充单价（如「雨伞 38元」）');
      fields = parsed;
      if (req.body.category) fields.category = req.body.category;
    } else {
      if (!req.body?.itemName) throw new HttpError(400, 'MISSING_FIELDS', '缺少字段: itemName');
      let unitPriceCents = Number(req.body.unitPriceCents);
      if (!Number.isFinite(unitPriceCents) && req.body.unitPrice != null) unitPriceCents = yuanToCents(req.body.unitPrice);
      if (!Number.isFinite(unitPriceCents)) throw new HttpError(400, 'INVALID', '缺少 unitPriceCents（或 unitPrice）');
      const quantity = Math.max(1, Math.round(Number(req.body.quantity) || 1));
      fields = {
        itemName: String(req.body.itemName).trim(),
        quantity,
        unitPriceCents,
        totalAmountCents: Number.isFinite(Number(req.body.totalAmountCents)) ? Number(req.body.totalAmountCents) : unitPriceCents * quantity,
        currency: 'CNY',
        category: req.body.category || guessCategory(req.body.itemName),
        purchasedAt: normDate(req.body.purchasedAt),
        note: req.body.note || '',
      };
    }

    const purchase = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...fields };

    // 购买并记账：可选，同时创建一条关联 Expense（purchaseId 关联）
    if (req.body.alsoExpense || req.body.alsoExpense === 'true') {
      const expense = {
        id: randomUUID(), title: purchase.itemName, category: purchase.category || '生活用品',
        amountCents: purchase.totalAmountCents, currency: 'CNY',
        occurredAt: purchase.purchasedAt, occurredTime: '', note: purchase.note || '',
        purchaseId: purchase.id, createdAt: Date.now(), updatedAt: Date.now(),
      };
      doc.expenses.push(expense);
      purchase.expenseId = expense.id;
    }

    doc.purchases.push(purchase);
    await putState(req.user.id, doc);
    ok(res, purchase, 201);
  } catch (e) { next(e); }
});

router.patch('/purchases/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const p = doc.purchases.find((x) => x.id === req.params.id);
    if (!p) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    const patch = pick(req.body, PURCHASE_FIELDS);
    // 数量或单价变化时重算总价（未显式给总价时）
    const qty = patch.quantity != null ? Math.max(1, Math.round(Number(patch.quantity))) : p.quantity;
    const unit = patch.unitPriceCents != null ? Number(patch.unitPriceCents) : p.unitPriceCents;
    if ((patch.quantity != null || patch.unitPriceCents != null) && req.body.totalAmountCents == null) patch.totalAmountCents = unit * qty;
    Object.assign(p, patch, { updatedAt: Date.now() });
    await putState(req.user.id, doc);
    ok(res, p);
  } catch (e) { next(e); }
});

router.delete('/purchases/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const before = doc.purchases.length;
    doc.purchases = doc.purchases.filter((x) => x.id !== req.params.id);
    // 关联的 Expense 一并删除（避免孤账）
    doc.expenses = doc.expenses.filter((e) => e.purchaseId !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true, removed: before > doc.purchases.length });
  } catch (e) { next(e); }
});

// ---- 记账 ----
router.get('/expenses', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let list = doc.expenses.slice().sort((a, b) => (b.occurredAt || '') < (a.occurredAt || '') ? -1 : 1);
    if (req.query.month) list = list.filter((e) => String(e.occurredAt || '').startsWith(String(req.query.month).slice(0, 7)));
    ok(res, list);
  } catch (e) { next(e); }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let fields;
    if (req.body?.text) {
      const parsed = parseExpenseText(req.body.text);
      if (!parsed) throw new HttpError(400, 'INVALID', '无法从文本解析出金额，请补充金额（如「麻辣烫 20元」）');
      fields = { ...parsed, occurredAt: normDate(req.body.occurredAt), occurredTime: req.body.occurredTime || '', note: req.body.note || '', kind: req.body.kind === 'income' ? 'income' : 'expense' };
      if (req.body.category) fields.category = req.body.category;
    } else {
      if (!req.body?.title) throw new HttpError(400, 'MISSING_FIELDS', '缺少字段: title');
      let amountCents = Number(req.body.amountCents);
      if (!Number.isFinite(amountCents) && req.body.amount != null) amountCents = yuanToCents(req.body.amount);
      if (!Number.isFinite(amountCents)) throw new HttpError(400, 'INVALID', '缺少 amountCents（或 amount）');
      fields = {
        title: String(req.body.title).trim(),
        category: req.body.category || guessCategory(req.body.title),
        amountCents,
        currency: 'CNY',
        kind: req.body.kind === 'income' ? 'income' : 'expense',
        occurredAt: normDate(req.body.occurredAt),
        occurredTime: req.body.occurredTime || '',
        note: req.body.note || '',
      };
    }
    const expense = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...fields };
    doc.expenses.push(expense);
    await putState(req.user.id, doc);
    ok(res, expense, 201);
  } catch (e) { next(e); }
});

router.patch('/expenses/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const e = doc.expenses.find((x) => x.id === req.params.id);
    if (!e) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    const patch = pick(req.body, EXPENSE_FIELDS);
    if (patch.amount != null && patch.amountCents == null) patch.amountCents = yuanToCents(patch.amount);
    delete patch.amount;
    if (patch.kind != null) patch.kind = patch.kind === 'income' ? 'income' : 'expense';
    Object.assign(e, patch, { updatedAt: Date.now() });
    await putState(req.user.id, doc);
    ok(res, e);
  } catch (e) { next(e); }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.expenses = doc.expenses.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// ---- 月预算 ----
router.get('/budget', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, { monthlyCents: doc.budget?.monthlyCents ?? null, currency: doc.budget?.currency || 'CNY', hasBudget: !!doc.budget?.monthlyCents });
  } catch (e) { next(e); }
});

router.put('/budget', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let monthlyCents = Number(req.body?.monthlyCents);
    if (!Number.isFinite(monthlyCents) && req.body?.monthlyBudget != null) monthlyCents = yuanToCents(req.body.monthlyBudget);
    if (!Number.isFinite(monthlyCents)) throw new HttpError(400, 'INVALID', '缺少 monthlyCents（或 monthlyBudget）');
    if (monthlyCents < 0) throw new HttpError(400, 'INVALID', '预算不能为负');
    doc.budget = { monthlyCents: Math.round(monthlyCents), currency: 'CNY', updatedAt: Date.now() };
    await putState(req.user.id, doc);
    ok(res, doc.budget);
  } catch (e) { next(e); }
});

// ---- 财务汇总（预算/已花/剩余/每日建议/分类统计） ----
router.get('/summary', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, financeSummary(doc));
  } catch (e) { next(e); }
});

router.get('/categories', async (req, res, next) => {
  try { ok(res, EXPENSE_CATEGORIES); } catch (e) { next(e); }
});

export default router;
