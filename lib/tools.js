// 内置领域工具（function calling）：财务 / 经期 / 病历。
// 复用 lib/ai.js 的 tools+callTool 循环 —— 与 MCP 插件同一套机制，不另起炉灶。
// callTool 返回字符串（JSON），由 AI 拼回对话。
import { randomUUID } from 'node:crypto';
import { getState, putState } from './domain.js';
import {
  todayStr, yuanToCents, parseExpenseText, parsePurchaseText, guessCategory, financeSummary,
} from './finance.js';
import { startCycle, endCycle, withCycleLengths, predict } from './menstrual.js';

const S = (name, description, properties = {}, required = []) => ({
  name, description,
  parameters: { type: 'object', properties, required },
});

const MONEY = { type: 'integer', description: '金额（分，整数。￥1 = 100）' };
const DATE = { type: 'string', description: '日期 YYYY-MM-DD（缺省今天）' };

// 工具定义（description 用中文，告诉 AI 何时用、参数含义）
const TOOL_DEFS = [
  S('get_recent_purchases', '读取用户最近购买记录（商品名、数量、单价、总价、时间、分类）', { limit: { type: 'integer' } }),
  S('add_purchase', '新增一条最近购买。优先从 text 自然语言解析（如「雨伞 38元」「雨伞 2把 38元」）；也可直接给结构化字段。', {
    text: { type: 'string', description: '自然语言描述，如「雨伞 38元」' },
    itemName: { type: 'string' }, quantity: { type: 'integer' }, unitPriceCents: MONEY,
    category: { type: 'string' }, purchasedAt: DATE, note: { type: 'string' },
    alsoExpense: { type: 'boolean', description: 'true=同时记一笔账（创建关联 Expense）' },
  }),
  S('update_purchase', '修改一条最近购买', { id: { type: 'string' }, itemName: { type: 'string' }, quantity: { type: 'integer' }, unitPriceCents: MONEY, category: { type: 'string' }, purchasedAt: DATE, note: { type: 'string' } }),
  S('delete_purchase', '删除一条最近购买（同时删除关联账目）', { id: { type: 'string' } }),

  S('get_expenses', '读取记账记录（条目、分类、金额、时间、收入/支出 kind）。可按 month=YYYY-MM 过滤。', { month: { type: 'string', description: 'YYYY-MM' } }),
  S('add_expense', '记一笔账（默认支出）。优先从 text 解析（如「麻辣烫 20元」「今天午饭 25块」）；也可给 title+amountCents。分类缺省时按条目自动判断。记收入（如「工资 5000」「发了 8000」）时传 kind="income"。', {
    text: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, amountCents: MONEY,
    amount: { type: 'number', description: '金额（元，备选）' }, kind: { type: 'string', description: 'expense=支出(默认)，income=收入' },
    occurredAt: DATE, occurredTime: { type: 'string' }, note: { type: 'string' },
  }),
  S('update_expense', '修改一条记账', { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, amountCents: MONEY, kind: { type: 'string' }, occurredAt: DATE, note: { type: 'string' } }),
  S('delete_expense', '删除一条记账', { id: { type: 'string' } }),

  S('get_budget', '读取本月预算设置', {}),
  S('set_monthly_budget', '设置本月预算（金额单位：分；或 monthlyBudget 用元）', { monthlyCents: MONEY, monthlyBudget: { type: 'number', description: '预算（元，备选）' } }),
  S('get_budget_summary', '读取预算汇总：本月预算/已花/剩余/剩余天数/每日建议/分类统计/今日本周花费', {}),

  S('get_health_records', '读取健康记录（睡眠小时/饮水升/摄入热量千卡/运动消耗千卡/体重公斤，按日期）', { days: { type: 'integer', description: '最近 N 天' } }),
  S('add_health_record', '记录当天健康数据（睡眠/饮水/体重）。按日期 upsert：该日已有记录则合并，否则新建。字段缺省不覆盖已有值。', {
    date: DATE, sleep: { type: 'number', description: '睡眠小时' }, water: { type: 'number', description: '饮水升' },
    weight: { type: 'number', description: '体重公斤' },
  }),
  S('record_calories_in', '累计摄入热量。根据食物描述估算的千卡数加到当天摄入热量(caloriesIn)。', { date: DATE, amount: { type: 'number', description: '摄入热量千卡' }, description: { type: 'string', description: '吃了什么' } }),
  S('record_calories_out', '累计运动消耗热量。根据运动描述估算的千卡数加到当天运动消耗(caloriesOut)。', { date: DATE, amount: { type: 'number', description: '消耗热量千卡' }, description: { type: 'string', description: '做了什么运动' } }),
  S('get_medical_records', '读取个人病历（过敏史/疾病/就诊/检查/手术/用药等）', { type: { type: 'string' } }),
  S('add_medical_record', '新增一条个人病历。可给 text（如「2026-09-10 感冒 发烧咳嗽」）或结构化字段。', {
    text: { type: 'string' }, title: { type: 'string' }, type: { type: 'string', description: '过敏史/疾病/就诊/检查/手术/用药/其他' },
    date: DATE, hospital: { type: 'string' }, doctor: { type: 'string' }, diagnosis: { type: 'string' },
    symptoms: { type: 'string' }, treatment: { type: 'string' }, medication: { type: 'string' }, notes: { type: 'string' },
  }),
  S('update_medical_record', '修改一条个人病历', { id: { type: 'string' }, title: { type: 'string' }, type: { type: 'string' }, date: DATE, diagnosis: { type: 'string' }, symptoms: { type: 'string' }, medication: { type: 'string' }, notes: { type: 'string' } }),
  S('delete_medical_record', '删除一条个人病历', { id: { type: 'string' } }),

  S('get_menstrual_cycles', '读取经期周期记录（开始/结束/持续天数/周期长度）', {}),
  S('add_period_start', '记录经期开始（幂等：若已有进行中的周期则返回它）', { date: DATE }),
  S('add_period_end', '记录经期结束（关闭进行中周期）', { date: DATE }),
  S('get_period_prediction', '读取经期预测：平均周期/持续/预计下次时间与范围/可信度', {}),
];

function toCents(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
function todayOr(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : todayStr(); }

export function buildDomainTools(userId) {
  const tools = TOOL_DEFS;

  const callTool = async (name, args = {}) => {
    const doc = await getState(userId);
    const save = async (result, code = 'OK') => { await putState(userId, doc); return JSON.stringify({ code, ...result }); };

    switch (name) {
      case 'get_recent_purchases': {
        const limit = Math.max(1, Math.min(50, parseInt(args.limit) || 20));
        return JSON.stringify({ code: 'OK', purchases: doc.purchases.slice().sort((a, b) => (b.purchasedAt || '') < (a.purchasedAt || '') ? -1 : 1).slice(0, limit) });
      }
      case 'add_purchase': {
        let f;
        if (args.text) { f = parsePurchaseText(args.text); if (!f) return JSON.stringify({ code: 'FAILED', error: '无法解析金额，请补充单价（如「雨伞 38元」）' }); }
        else {
          if (!args.itemName) return JSON.stringify({ code: 'FAILED', error: '缺少 itemName' });
          const unitPriceCents = toCents(args.unitPriceCents) ?? (args.unitPrice != null ? yuanToCents(args.unitPrice) : null);
          if (unitPriceCents == null) return JSON.stringify({ code: 'FAILED', error: '缺少单价' });
          const quantity = Math.max(1, parseInt(args.quantity) || 1);
          f = { itemName: String(args.itemName).trim(), quantity, unitPriceCents, totalAmountCents: unitPriceCents * quantity, currency: 'CNY', category: args.category || guessCategory(args.itemName), purchasedAt: todayOr(args.purchasedAt), note: args.note || '' };
        }
        const purchase = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        if (args.alsoExpense) {
          const expense = { id: randomUUID(), title: purchase.itemName, category: purchase.category || '生活用品', amountCents: purchase.totalAmountCents, currency: 'CNY', occurredAt: purchase.purchasedAt, occurredTime: '', note: purchase.note || '', purchaseId: purchase.id, createdAt: Date.now(), updatedAt: Date.now() };
          doc.expenses.push(expense); purchase.expenseId = expense.id;
        }
        doc.purchases.push(purchase);
        return save({ purchase }, 'CREATED');
      }
      case 'update_purchase': {
        const p = doc.purchases.find((x) => x.id === args.id); if (!p) return JSON.stringify({ code: 'NOT_FOUND', error: '购买记录不存在' });
        if (args.itemName != null) p.itemName = String(args.itemName);
        if (args.quantity != null) p.quantity = Math.max(1, parseInt(args.quantity));
        if (args.unitPriceCents != null) p.unitPriceCents = toCents(args.unitPriceCents);
        if (args.quantity != null || args.unitPriceCents != null) p.totalAmountCents = p.unitPriceCents * p.quantity;
        if (args.category != null) p.category = args.category;
        if (args.purchasedAt != null) p.purchasedAt = todayOr(args.purchasedAt);
        if (args.note != null) p.note = args.note;
        p.updatedAt = Date.now();
        return save({ purchase: p });
      }
      case 'delete_purchase': {
        const before = doc.purchases.length;
        doc.purchases = doc.purchases.filter((x) => x.id !== args.id);
        doc.expenses = doc.expenses.filter((e) => e.purchaseId !== args.id);
        return save({ ok: true, removed: before > doc.purchases.length });
      }

      case 'get_expenses': {
        let list = doc.expenses.slice().sort((a, b) => (b.occurredAt || '') < (a.occurredAt || '') ? -1 : 1);
        if (args.month) list = list.filter((e) => String(e.occurredAt || '').startsWith(String(args.month).slice(0, 7)));
        return JSON.stringify({ code: 'OK', expenses: list.slice(0, 100) });
      }
      case 'add_expense': {
        let f;
        if (args.text) { f = parseExpenseText(args.text); if (!f) return JSON.stringify({ code: 'FAILED', error: '无法解析金额，请补充金额（如「麻辣烫 20元」）' }); }
        else {
          if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
          const amountCents = toCents(args.amountCents) ?? (args.amount != null ? yuanToCents(args.amount) : null);
          if (amountCents == null) return JSON.stringify({ code: 'FAILED', error: '缺少金额' });
          f = { title: String(args.title).trim(), category: args.category || guessCategory(args.title), amountCents, currency: 'CNY', occurredAt: todayOr(args.occurredAt), occurredTime: args.occurredTime || '', note: args.note || '' };
        }
        f.kind = args.kind === 'income' ? 'income' : 'expense';
        const expense = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        doc.expenses.push(expense);
        return save({ expense }, 'CREATED');
      }
      case 'update_expense': {
        const e = doc.expenses.find((x) => x.id === args.id); if (!e) return JSON.stringify({ code: 'NOT_FOUND', error: '记账不存在' });
        if (args.title != null) e.title = String(args.title);
        if (args.category != null) e.category = args.category;
        if (args.amountCents != null) e.amountCents = toCents(args.amountCents);
        if (args.kind != null) e.kind = args.kind === 'income' ? 'income' : 'expense';
        if (args.occurredAt != null) e.occurredAt = todayOr(args.occurredAt);
        if (args.note != null) e.note = args.note;
        e.updatedAt = Date.now();
        return save({ expense: e });
      }
      case 'delete_expense': {
        doc.expenses = doc.expenses.filter((x) => x.id !== args.id);
        return save({ ok: true });
      }

      case 'get_budget':
        return JSON.stringify({ code: 'OK', monthlyCents: doc.budget?.monthlyCents ?? null, currency: 'CNY', hasBudget: !!doc.budget?.monthlyCents });
      case 'set_monthly_budget': {
        let monthlyCents = toCents(args.monthlyCents) ?? (args.monthlyBudget != null ? yuanToCents(args.monthlyBudget) : null);
        if (monthlyCents == null || monthlyCents < 0) return JSON.stringify({ code: 'FAILED', error: '预算金额无效' });
        doc.budget = { monthlyCents, currency: 'CNY', updatedAt: Date.now() };
        return save({ budget: doc.budget });
      }
      case 'get_budget_summary':
        return JSON.stringify({ code: 'OK', summary: financeSummary(doc) });

      case 'get_health_records': {
        const days = Math.max(1, Math.min(60, parseInt(args.days) || 7));
        const from = new Date(); from.setDate(from.getDate() - (days - 1));
        const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const cutoff = dstr(from);
        const recs = doc.health.filter((r) => r.date >= cutoff).sort((a, b) => (a.date < b.date ? -1 : 1));
        return JSON.stringify({ code: 'OK', records: recs });
      }
      case 'add_health_record': {
        const date = todayOr(args.date);
        let rec = doc.health.find((r) => r.date === date);
        if (!rec) { rec = { id: randomUUID(), date, sleep: 0, water: 0, caloriesIn: 0, caloriesOut: 0, weight: null }; doc.health.push(rec); }
        for (const k of ['sleep', 'water', 'weight']) {
          const v = Number(args[k]);
          if (Number.isFinite(v)) rec[k] = v;
        }
        rec.updatedAt = Date.now();
        return save({ record: rec });
      }
      case 'record_calories_in':
      case 'record_calories_out': {
        const isIn = name === 'record_calories_in';
        const date = todayOr(args.date);
        let rec = doc.health.find((r) => r.date === date);
        if (!rec) { rec = { id: randomUUID(), date, sleep: 0, water: 0, caloriesIn: 0, caloriesOut: 0, weight: null }; doc.health.push(rec); }
        const amount = Math.max(0, Math.round(Number(args.amount) || 0));
        const key = isIn ? 'caloriesIn' : 'caloriesOut';
        rec[key] = (Number(rec[key]) || 0) + amount;
        if (args.description) rec[(isIn ? 'foodLog' : 'exerciseLog')] = String(args.description);
        rec.updatedAt = Date.now();
        return save({ record: rec });
      }
      case 'get_medical_records': {
        let list = doc.medicalRecords.slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
        if (args.type) list = list.filter((r) => r.type === args.type);
        return JSON.stringify({ code: 'OK', records: list });
      }
      case 'add_medical_record': {
        let f;
        if (args.text && !args.title) {
          const t = String(args.text).trim();
          const dm = t.match(/^(\d{4}-\d{2}-\d{2})\s+/);
          const date = dm ? dm[1] : todayStr();
          const rest = dm ? t.slice(dm[0].length) : t;
          const noteM = rest.match(/备注[:：]\s*(.+)$/);
          const body = noteM ? rest.slice(0, noteM.index).trim() : rest;
          f = { title: args.title || body.split(/[，,。\s]/)[0] || body, type: args.type || '就诊', date, diagnosis: args.diagnosis || body, symptoms: args.symptoms || '', medication: args.medication || '', notes: noteM ? noteM[1] : (args.notes || ''), source: 'user' };
        } else {
          if (!args.title) return JSON.stringify({ code: 'FAILED', error: '缺少 title' });
          f = { title: String(args.title), type: args.type || '其他', date: todayOr(args.date), hospital: args.hospital || '', doctor: args.doctor || '', diagnosis: args.diagnosis || '', symptoms: args.symptoms || '', treatment: args.treatment || '', medication: args.medication || '', notes: args.notes || '', source: args.source || 'user' };
        }
        const rec = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...f };
        doc.medicalRecords.push(rec);
        return save({ record: rec }, 'CREATED');
      }
      case 'update_medical_record': {
        const r = doc.medicalRecords.find((x) => x.id === args.id); if (!r) return JSON.stringify({ code: 'NOT_FOUND', error: '病历不存在' });
        for (const k of ['title', 'type', 'date', 'hospital', 'doctor', 'diagnosis', 'symptoms', 'treatment', 'medication', 'notes']) if (args[k] != null) r[k] = args[k];
        r.updatedAt = Date.now();
        return save({ record: r });
      }
      case 'delete_medical_record': {
        doc.medicalRecords = doc.medicalRecords.filter((x) => x.id !== args.id);
        return save({ ok: true });
      }

      case 'get_menstrual_cycles':
        return JSON.stringify({ code: 'OK', cycles: withCycleLengths(doc.menstrualCycles) });
      case 'add_period_start': {
        const { cycle, created } = startCycle(doc.menstrualCycles, todayOr(args.date));
        if (created) { cycle.id = randomUUID(); doc.menstrualCycles.push(cycle); }
        return save({ cycle, created }, created ? 'CREATED' : 'OK');
      }
      case 'add_period_end': {
        const { cycle, closed } = endCycle(doc.menstrualCycles, todayOr(args.date));
        if (!closed) return JSON.stringify({ code: 'CONFLICT', error: '没有进行中的经期' });
        return save({ cycle, closed: true });
      }
      case 'get_period_prediction':
        return JSON.stringify({ code: 'OK', prediction: predict(doc.menstrualCycles, todayStr()) });

      default:
        return JSON.stringify({ code: 'UNKNOWN_TOOL', error: '未知工具: ' + name });
    }
  };

  return { tools, callTool, names: TOOL_DEFS.map((t) => t.name) };
}
