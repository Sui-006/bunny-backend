// 财务工具：金额一律用「整数分」（amountCents）存取，杜绝 JS 浮点精度问题。
// 例如 ￥38 → 3800，￥0.5 → 50。前端负责展示时 /100。
// 提供：自然语言解析（记账/购买）、分类猜测、月预算动态计算。

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dstr(new Date());

// 字符串日期 → Date（本地时区）；非法返回 null
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

export function startOfWeek(s) {
  const d = parseDate(s) || new Date();
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return dstr(d);
}

// 某日期所在月份 "YYYY-MM"
export function monthKey(s) {
  const d = parseDate(s) || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ---- 金额换算 ----
export function yuanToCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
export function centsToYuan(c) {
  const n = Number(c);
  return Number.isFinite(n) ? n / 100 : 0;
}
export const fmtCents = (c) => '￥' + (centsToYuan(c)).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

// ---- 分类 ----
export const EXPENSE_CATEGORIES = ['吃饭', '娱乐', '生活用品', '看病', '零食', '学习', '交通', '住房', '通讯', '服饰', '旅行', '其他'];

// 关键词命中表（顺序即优先级：越具体越靠前）
const CATEGORY_KEYWORDS = [
  ['交通', /打车|地铁|公交|车票|滴滴|加油|停车|高铁|机票|火车|出租|单车|骑行|地铁卡/],
  ['学习', /书|课程|学习|培训|资料|文具|笔|本子|教材|会员|订阅|学费/],
  ['看病', /医院|看病|门诊|挂号|体检|输液|药|诊所|检查费|疫苗/],
  ['娱乐', /电影|游戏|ktv|唱歌|娱乐|门票|演出|剧本杀|密室|健身|游泳|门票/],
  ['生活用品', /生活|日用品|洗衣|纸巾|洗发|牙膏|沐浴|家居|伞|雨伞|洗衣液|垃圾袋|毛巾|被子|纸|清洁/],
  ['通讯', /话费|流量|宽带|手机|通讯|网费|电话/],
  ['住房', /房租|水电|物业|燃气|租金|房贷/],
  ['服饰', /衣服|鞋|裤|衣|帽|服饰|包|袜|围巾|裙子|外套/],
  ['旅行', /旅行|旅游|酒店|景点|民宿|机票|签证/],
  ['零食', /薯片|零食|饼干|糖|蛋糕|冰淇淋|饮料|可乐|奶茶|水果|坚果|雪糕/],
  ['吃饭', /饭|吃|餐|面|麻辣烫|拉面|火锅|外卖|食堂|早餐|午餐|晚餐|夜宵|烧烤|串|粉|咖啡|茶|水|粥|包子|饺子|菜/],
];

export function guessCategory(title) {
  const t = String(title || '');
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(t)) return cat;
  return '其他';
}

// ---- 自然语言解析 ----
// 从文本提取金额（分）。优先「数字+币种符号（￥/¥/元/块）」，其次末尾数字。
// 返回 null 表示没有明确金额。
export function parseAmountCents(text) {
  const t = String(text || '');
  let m = t.match(/(\d+(?:\.\d{1,2})?)\s*[￥¥元块]/);
  if (m) return yuanToCents(m[1]);
  m = t.match(/(\d+(?:\.\d{1,2})?)\s*$/);
  if (m) return yuanToCents(m[1]);
  return null;
}

// 从文本提取数量：`×1` `*1` `x2` `2把` `3个` `1件` 等；默认 1。
export function parseQuantity(text) {
  const t = String(text || '');
  let m = t.match(/[×*xX]\s*(\d+)/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  m = t.match(/(\d+)\s*(?:把|个|件|份|支|盒|包|瓶|双|条|斤|本|台|张|件|套)/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  return 1;
}

// 去掉金额/数量/币种/数量单位等噪声，得到干净的条目名
function cleanTitle(text) {
  return String(text || '')
    .replace(/[￥¥]\s*(\d+(?:\.\d{1,2})?)/g, '')
    .replace(/(\d+(?:\.\d{1,2})?)\s*[￥¥元块钱]/g, '')
    .replace(/[×*xX]\s*\d+/g, '')
    .replace(/\d+\s*(?:把|个|件|份|支|盒|包|瓶|双|条|斤|本|台|张|套)/g, '')
    .replace(/[，,。.\s]+/g, ' ')
    .trim();
}

// 解析「记账」文本 → { title, category, amountCents }
// 例：`麻辣烫 吃饭 ￥20` / `打车18` / `今天午饭 25块`
export function parseExpenseText(text) {
  const amountCents = parseAmountCents(text);
  if (amountCents == null) return null;
  const cleaned = cleanTitle(text);
  // 显式分类：文本中出现「吃饭/交通/…」这类词时以它为准
  let category = null;
  for (const c of EXPENSE_CATEGORIES) if (String(text || '').includes(c)) { category = c; break; }
  if (!category) category = guessCategory(cleaned);
  // 条目名：清理后去掉显式分类词
  let title = cleaned;
  if (category && category !== '其他') title = title.split(' ').filter((w) => w !== category && !CATEGORY_KEYWORDS.some(([c, re]) => c === category && re.test(w) && re.test(category))).join(' ').trim();
  if (!title) title = cleaned || '未命名';
  return { title, category: category || '其他', amountCents, currency: 'CNY' };
}

// 解析「最近购买」文本 → { itemName, quantity, unitPriceCents, totalAmountCents, category }
// 例：`雨伞 ×1 ￥38` → 数量 1、单价 38、总价 38；`雨伞 2把 38元` → 数量 2、单价 38、总价 76。
export function parsePurchaseText(text) {
  const amountCents = parseAmountCents(text);
  if (amountCents == null) return null;
  const quantity = parseQuantity(text);
  const cleaned = cleanTitle(text);
  let itemName = cleaned;
  const category = guessCategory(cleaned);
  if (!itemName) itemName = cleaned || '未命名商品';
  // 单价 = 明确金额；总价 = 单价 × 数量（若用户只报了一个数，视为单价）
  const unitPriceCents = amountCents;
  const totalAmountCents = unitPriceCents * quantity;
  return { itemName, quantity, unitPriceCents, totalAmountCents, currency: 'CNY', category };
}

// ---- 预算动态计算 ----
export function daysRemainingInMonth(s) {
  const d = parseDate(s) || new Date();
  const total = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Math.max(0, total - d.getDate()); // 不含今天（今天已单独统计）
}

// 汇总财务数据（供 AI / 前端预算页共用）
// doc 为生活数据文档；today 默认今天。金额统一分。
export function financeSummary(doc, today = todayStr()) {
  const expenses = (doc.expenses || []).slice().sort((a, b) => (a.occurredAt || '') < (b.occurredAt || '') ? 1 : -1);
  const purchases = (doc.purchases || []).slice().sort((a, b) => (a.purchasedAt || '') < (b.purchasedAt || '') ? 1 : -1);

  const mk = monthKey(today);
  const ws = startOfWeek(today);
  const sum = (arr) => arr.reduce((s, e) => s + (Number(e.amountCents) || 0), 0);

  const monthExpenses = expenses.filter((e) => monthKey(e.occurredAt) === mk);
  const monthExpenseCents = sum(monthExpenses);
  const todayExpenseCents = sum(expenses.filter((e) => e.occurredAt === today));
  const weekExpenseCents = sum(expenses.filter((e) => e.occurredAt >= ws && e.occurredAt <= today));

  const monthlyBudgetCents = Number(doc.budget?.monthlyCents) || 0;
  const hasBudget = !!doc.budget?.monthlyCents;
  const remainingCents = hasBudget ? monthlyBudgetCents - monthExpenseCents : 0;
  const remainingDays = daysRemainingInMonth(today);
  const recommendedDailyBudgetCents = hasBudget && remainingDays > 0 && remainingCents > 0 ? Math.max(0, Math.round(remainingCents / remainingDays)) : 0;

  // 分类统计（本月）
  const categoryBreakdown = {};
  for (const e of monthExpenses) {
    const c = e.category || '其他';
    categoryBreakdown[c] = (categoryBreakdown[c] || 0) + (Number(e.amountCents) || 0);
  }

  return {
    currency: 'CNY',
    hasBudget,
    monthlyBudgetCents,
    monthExpenseCents,
    remainingCents,
    remainingDays,
    recommendedDailyBudgetCents,
    todayExpenseCents,
    weekExpenseCents,
    categoryBreakdown, // { 分类: 分 }
    recentExpenses: expenses.slice(0, 20),
    recentPurchases: purchases.slice(0, 20),
    monthExpenseCount: monthExpenses.length,
  };
}
