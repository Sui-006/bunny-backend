import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { getState, putState, defaultPlan } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';
import { parseExpenseText, parsePurchaseText, guessCategory } from '../lib/finance.js';

const router = Router();

function stripFences(s) {
  return String(s || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

// 统一把「缺 Key」等错误转成 503
async function aiCall(opts) {
  try {
    return await chat(opts);
  } catch (e) {
    if (/API Key|缺少|密钥/i.test(e.message)) throw new HttpError(503, 'NO_AI_KEY', e.message);
    throw e;
  }
}

// POST /api/ai/task/parse —— 自然语言 → { title, date, time }
router.post('/task/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    const reply = await aiCall({
      model: config.defaultModel, temperature: 0.2, maxTokens: 300,
      system: '你是日程解析助手。根据用户的话提取任务标题、日期(YYYY-MM-DD)、时间(HH:mm，没有就空)。只输出 JSON：{"title":"...","date":"...","time":"..."}。日期不确定就用今天。',
      messages: [{ role: 'user', content: text }],
    });
    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    if (!parsed || !parsed.title) throw new HttpError(502, 'PARSE_FAILED', 'AI 返回无法解析');
    ok(res, parsed);
  } catch (e) { next(e); }
});

// POST /api/ai/alarm/parse —— 自然语言 → 提醒意图分类（普通提醒 / 时间敏感 / 闹钟）
// 只有用户明确「设闹钟 / 叫我 / 强提醒 / 到点一定要提醒我」才判定为 ALARM。
router.post('/alarm/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    const reply = await aiCall({
      model: config.defaultModel, temperature: 0.2, maxTokens: 400,
      system: '你是提醒解析助手。根据用户的话判断这是普通提醒/日程、时间敏感提醒，还是明确的闹钟（强提醒）。只输出 JSON：{"notificationType":"NORMAL"|"TIME_SENSITIVE"|"ALARM","alarmIntent":true|false,"time":"HH:mm","date":"YYYY-MM-DD或空","repeat":"once"|"daily"|"weekdays"|"custom","title":"...","body":"..."}。规则：只有用户明确说「设闹钟/叫我/强提醒/到点一定要提醒我」等才设 notificationType=ALARM 且 alarmIntent=true；普通会议/任务/提醒用 NORMAL 或 TIME_SENSITIVE，绝不能因为事件重要就升级成 ALARM。时间/日期不确定就填空字符串。title/body 用自然中文。',
      messages: [{ role: 'user', content: text }],
    });
    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    if (!parsed || typeof parsed !== 'object') throw new HttpError(502, 'PARSE_FAILED', 'AI 返回无法解析');
    ok(res, parsed);
  } catch (e) { next(e); }
});

// POST /api/ai/plan —— 生成计划预览（不落库，等用户确认）
router.post('/plan', async (req, res, next) => {
  try {
    const goal = String(req.body?.goal || '').trim();
    if (!goal) throw new HttpError(400, 'INVALID', 'goal 不能为空');
    const reply = await aiCall({
      model: config.defaultModel, temperature: 0.4, maxTokens: 1500,
      system: '你是计划助手。根据用户目标生成结构化计划，只输出 JSON，形如 {"longTerm":{"title":"...","longGoal":"..."},"stages":[{"title":"...","goals":[{"title":"...","progress":0}]}],"tasks":[{"title":"...","date":"YYYY-MM-DD"}]}。',
      messages: [{ role: 'user', content: goal }],
    });
    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    if (!parsed || typeof parsed !== 'object') throw new HttpError(502, 'PARSE_FAILED', 'AI 返回无法解析');
    ok(res, { preview: parsed });
  } catch (e) { next(e); }
});

// POST /api/ai/plan/confirm —— 确认预览并一次性落库（单文档写入 = 原子，失败不残留半成品）
router.post('/plan/confirm', async (req, res, next) => {
  try {
    const preview = req.body?.preview;
    if (!preview || typeof preview !== 'object') throw new HttpError(400, 'INVALID', 'preview 缺失');

    const doc = await getState(req.user.id);
    const longTerm = {
      ...defaultPlan('long-term'),
      title: preview.longTerm?.title || '我的长期计划',
      longGoal: preview.longTerm?.longGoal || '',
    };
    doc.plans.push(longTerm);

    for (const s of preview.stages || []) {
      const stage = {
        ...defaultPlan('stage'),
        title: s.title || '阶段',
        parentPlanId: longTerm.id,
        stageGoals: (s.goals || []).map((g) => ({
          id: randomUUID(), title: g.title || '目标', progress: Number(g.progress) || 0, dueDate: '', completed: false, result: '',
        })),
      };
      doc.plans.push(stage);
    }

    for (const t of preview.tasks || []) {
      doc.tasks.push({
        id: randomUUID(), planId: null, weeklyPlanId: null, monthlyPlanId: null, stagePlanId: null, longTermPlanId: null,
        order: Date.now(), createdAt: Date.now(), title: t.title || '任务', date: t.date || '', time: t.time || '',
        completed: false, priority: 'med', note: '', tags: [],
      });
    }

    await putState(req.user.id, doc);
    ok(res, { ok: true, plans: doc.plans.length, tasks: doc.tasks.length }, 201);
  } catch (e) { next(e); }
});

// POST /api/ai/expense/parse —— 自然语言 → 记账字段（AI 优先，确定性解析兜底）
router.post('/expense/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    const det = parseExpenseText(text);
    try {
      const reply = await aiCall({
        model: config.defaultModel, temperature: 0.1, maxTokens: 300,
        system: '你是记账解析助手。根据用户的话提取条目(title)、分类(category，从 吃饭/娱乐/生活用品/看病/零食/学习/交通/住房/通讯/服饰/旅行/其他 选)、金额(amountCents，整数分，￥1=100，缺失填 null)。只输出 JSON：{"title":"...","category":"...","amountCents":number|null}。分类按语义判断；用户明确指定分类则以用户为准。金额不确定就 amountCents:null。',
        messages: [{ role: 'user', content: text }],
      });
      const parsed = JSON.parse(stripFences(reply.content));
      if (parsed && (parsed.title || parsed.amountCents != null)) {
        return ok(res, {
          title: parsed.title || (det?.title || text),
          category: parsed.category || det?.category || '其他',
          amountCents: parsed.amountCents != null ? parsed.amountCents : det?.amountCents ?? null,
          currency: 'CNY',
        });
      }
    } catch (e) { /* AI 失败 → 回退确定性解析 */ }
    if (!det) throw new HttpError(400, 'INVALID', '没识别出金额，请补上（如「麻辣烫 20元」）');
    ok(res, det);
  } catch (e) { next(e); }
});

// POST /api/ai/purchase/parse —— 自然语言 → 最近购买字段
router.post('/purchase/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    const det = parsePurchaseText(text);
    try {
      const reply = await aiCall({
        model: config.defaultModel, temperature: 0.1, maxTokens: 300,
        system: '你是购物解析助手。根据用户的话提取商品名(itemName)、数量(quantity，缺省1)、单价(unitPriceCents，整数分，￥1=100，缺失填 null)、分类(category，从 吃饭/娱乐/生活用品/看病/零食/学习/交通/住房/通讯/服饰/旅行/其他 选)。只输出 JSON：{"itemName":"...","quantity":number,"unitPriceCents":number|null,"category":"..."}。单价不确定就 unitPriceCents:null，绝不擅自捏造金额。',
        messages: [{ role: 'user', content: text }],
      });
      const parsed = JSON.parse(stripFences(reply.content));
      if (parsed && parsed.itemName && parsed.unitPriceCents != null) {
        const q = Math.max(1, Math.round(Number(parsed.quantity) || 1));
        const unit = parsed.unitPriceCents;
        return ok(res, { itemName: parsed.itemName, quantity: q, unitPriceCents: unit, totalAmountCents: unit * q, currency: 'CNY', category: parsed.category || '其他' });
      }
    } catch (e) { /* AI 失败 → 回退 */ }
    if (!det) throw new HttpError(400, 'INVALID', '没识别出单价，请补上（如「雨伞 38元」）');
    ok(res, det);
  } catch (e) { next(e); }
});

// POST /api/ai/medical/parse —— 自然语言 → 病历字段（区分「用户自述」与「医生诊断」）
router.post('/medical/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    try {
      const reply = await aiCall({
        model: config.defaultModel, temperature: 0.2, maxTokens: 400,
        system: '你是病历记录助手。根据用户的话提取健康信息，只输出 JSON：{"title":"...","type":"过敏史|疾病|就诊|检查|手术|用药|其他","date":"YYYY-MM-DD或空","diagnosis":"...","symptoms":"...","notes":"...","source":"doctor|user"}。关键规则：只有医生明确诊断的内容才标 source=doctor 并写进 diagnosis；用户自己感觉/猜测的（如「我可能感冒了」）标 source=user 且 diagnosis 留空、症状写进 symptoms。绝不能把用户自述当成确诊。',
        messages: [{ role: 'user', content: text }],
      });
      const parsed = JSON.parse(stripFences(reply.content));
      if (parsed && parsed.title) return ok(res, parsed);
    } catch (e) { /* AI 失败 → 回退 */ }
    ok(res, { title: text, type: '其他', date: '', diagnosis: '', symptoms: '', notes: '', source: 'user' });
  } catch (e) { next(e); }
});

export default router;
