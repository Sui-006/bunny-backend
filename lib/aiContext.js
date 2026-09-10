// AI 结构化上下文：按用户问题选择性注入真实生活数据（财务/经期/病历/购物），
// 绝不把整份文档塞进 Prompt，降低 token 消耗并保护隐私。
// 这些是「只读事实」；AI 若要写入，走 lib/tools.js 的领域工具。
import { financeSummary, fmtCents, todayStr } from './finance.js';
import { withCycleLengths, predict } from './menstrual.js';

// 相关性关键词（保守命中，避免普通闲聊误注入）
const DOMAIN_PATTERNS = [
  ['finance', /买|购买|购物|花钱|花了|消费|开销|支出|账单|账本|记账|预算|多少钱|花了多少|还剩|剩余|花销|价格|贵|省钱|生活费|日用品|账单|欠|付款|收据/],
  ['menstrual', /经期|月经|例假|大姨妈|生理期|姨妈|period|排卵/],
  ['medical', /病历|过敏|看病|医院|医生|诊断|手术|病史|生病|感冒|发烧|咳嗽|吃药|药|体检|症状|既往|慢病|血压|血糖|就诊|复诊/],
];

export function detectDomains(text) {
  const t = String(text || '');
  return DOMAIN_PATTERNS.filter(([, re]) => re.test(t)).map(([d]) => d);
}

function centsFmt(c) { return fmtCents(c); }

// 财务上下文（预算 + 本月 + 分类 + 最近消费/购买）
function financeBlock(doc) {
  const s = financeSummary(doc, todayStr());
  const lines = [];
  if (s.hasBudget) {
    lines.push(`- 本月预算：${centsFmt(s.monthlyBudgetCents)}（已设置）`);
    lines.push(`- 本月已花：${centsFmt(s.monthExpenseCents)}（${s.monthExpenseCount} 笔）；剩余：${centsFmt(s.remainingCents)}`);
    lines.push(`- 本月还剩 ${s.remainingDays} 天；建议每日 ≤ ${centsFmt(s.recommendedDailyBudgetCents)}`);
  } else {
    lines.push('- 尚未设置本月预算');
    lines.push(`- 本月已花：${centsFmt(s.monthExpenseCents)}（${s.monthExpenseCount} 笔）`);
  }
  lines.push(`- 今日已花：${centsFmt(s.todayExpenseCents)}；本周已花：${centsFmt(s.weekExpenseCents)}`);
  const cats = Object.entries(s.categoryBreakdown).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${centsFmt(v)}`);
  if (cats.length) lines.push(`- 本月分类：${cats.join('、')}`);
  const re = s.recentExpenses.slice(0, 10).map((e) => `${e.title} ${centsFmt(e.amountCents)}（${e.category || '其他'}${e.occurredAt ? '·' + e.occurredAt : ''}）`);
  if (re.length) lines.push(`- 最近消费：${re.join('、')}`);
  const rp = s.recentPurchases.slice(0, 10).map((p) => `${p.itemName} ×${p.quantity} ${centsFmt(p.totalAmountCents)}（${p.category || '其他'}${p.purchasedAt ? '·' + p.purchasedAt : ''}）`);
  if (rp.length) lines.push(`- 最近购买：${rp.join('、')}`);
  return '【财务数据（真实记录，来自用户账本）】\n' + lines.join('\n');
}

// 经期上下文
function menstrualBlock(doc) {
  const pred = predict(doc.menstrualCycles, todayStr());
  const lines = [];
  if (pred.lastStart) {
    lines.push(`- 最近一次开始：${pred.lastStart}${pred.lastEnd ? '，结束：' + pred.lastEnd : '（进行中）'}`);
  }
  if (pred.averageCycleLengthDays) lines.push(`- 平均周期：约 ${pred.averageCycleLengthDays} 天`);
  if (pred.averageDurationDays) lines.push(`- 平均持续：约 ${pred.averageDurationDays} 天`);
  if (pred.status === 'ready') {
    lines.push(`- 预计下次：${pred.predictedStart} 左右（范围 ${pred.rangeStart} ~ ${pred.rangeEnd}，可信度 ${pred.confidence}）`);
  } else {
    lines.push(`- ${pred.note || '历史数据不足，暂无法预测。'}`);
  }
  const rc = withCycleLengths(doc.menstrualCycles).slice(0, 8).map((c) => `${c.startDate}${c.endDate ? '→' + c.endDate : '（进行中）'}${c.cycleLengthDays ? '，周期 ' + c.cycleLengthDays + ' 天' : ''}`);
  if (rc.length) lines.push(`- 最近周期：${rc.join('；')}`);
  lines.push('- 注意：预测仅供参考，不构成医学诊断。涉及异常出血、剧痛、怀孕等请咨询专业医疗人员。');
  return '【经期记录（真实数据，敏感隐私）】\n' + lines.join('\n');
}

// 个人病历上下文
function medicalBlock(doc) {
  const recs = (doc.medicalRecords || []).slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
  if (!recs.length) return '【个人病历】\n- 目前没有找到记录过的病历信息。';
  const lines = recs.slice(0, 10).map((r) => {
    const parts = [];
    if (r.type) parts.push(`[${r.type}]`);
    parts.push(r.title);
    if (r.date) parts.push(r.date);
    if (r.diagnosis) parts.push('诊断：' + r.diagnosis);
    if (r.symptoms) parts.push('症状：' + r.symptoms);
    if (r.medication) parts.push('用药：' + r.medication);
    return '- ' + parts.join(' ');
  });
  if (recs.length > 10) lines.push(`- …共 ${recs.length} 条，仅列最近 10 条`);
  lines.push('- 重要：「没有记录」不等于「没有发生过」；若找不到相关信息，请如实说「没有找到相关记录」，不要断言用户没有该病史。');
  return '【个人病历（真实记录，敏感隐私，仅用于回答用户本人的健康询问）】\n' + lines.join('\n');
}

// 根据用户问题返回要注入的结构化上下文片段（无相关性时返回空字符串）
export function buildContextSnippet(doc, text) {
  const domains = detectDomains(text);
  if (domains.length === 0) return '';
  const blocks = [];
  if (domains.includes('finance')) blocks.push(financeBlock(doc));
  if (domains.includes('menstrual')) blocks.push(menstrualBlock(doc));
  if (domains.includes('medical')) blocks.push(medicalBlock(doc));
  return blocks.join('\n\n');
}

// 供 AI 工具/前端直接取用的结构化上下文对象（比字符串更适合程序消费）
export function structuredContext(doc) {
  const s = financeSummary(doc, todayStr());
  const pred = predict(doc.menstrualCycles, todayStr());
  const recs = (doc.medicalRecords || []).slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
  return {
    finance: {
      hasBudget: s.hasBudget, monthlyBudgetCents: s.monthlyBudgetCents, monthExpenseCents: s.monthExpenseCents,
      remainingCents: s.remainingCents, remainingDays: s.remainingDays, recommendedDailyBudgetCents: s.recommendedDailyBudgetCents,
      todayExpenseCents: s.todayExpenseCents, weekExpenseCents: s.weekExpenseCents, categoryBreakdown: s.categoryBreakdown,
      recentExpenses: s.recentExpenses.slice(0, 20), recentPurchases: s.recentPurchases.slice(0, 20),
    },
    menstrual: pred,
    medical: { records: recs.slice(0, 20), total: recs.length },
  };
}
