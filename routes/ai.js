import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { chat, providerForModel, resolveAssistantModel, supportsToolCalling } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { getState, putState, defaultPlan } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';
import { parseExpenseText, parsePurchaseText, guessCategory, financeSummary, centsToYuan } from '../lib/finance.js';
import { AI_PERMISSION_POLICY, USER_ONLY_EDITABLE } from '../lib/permissions.js';
import { buildDomainTools } from '../lib/tools.js';

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

// GET /api/ai/permissions —— AI 权限策略只读展示（固定后端策略，前端设置页只读）
router.get('/permissions', async (req, res, next) => {
  try {
    ok(res, { policy: AI_PERMISSION_POLICY, userOnlyEditable: [...USER_ONLY_EDITABLE] });
  } catch (e) { next(e); }
});

// POST /api/ai/respond —— 用户操作事件 → AI 自行判断是否回应 + 动态生成回应（非硬编码）
// 前端把所有「成功完成」的业务操作统一喂进来；AI 决定回不回应，回应文案完全由模型生成。
router.post('/respond', async (req, res, next) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length === 0) return ok(res, { respond: false });

    const desc = events.slice(0, 8).map((ev) => {
      const p = ev.payload || {};
      const bits = [];
      if (p.title) bits.push(p.title);
      if (p.name) bits.push(p.name);
      if (p.type) bits.push(p.type);
      if (p.category) bits.push(p.category);
      if (p.value != null) bits.push(String(p.value));
      return (ev.type || '操作') + (bits.length ? '：' + bits.join('，') : '');
    }).join('\n');

    let reply;
    try {
      reply = await aiCall({
        model: config.defaultModel, temperature: 0.7, maxTokens: 300,
        system: '你是 Bunny\'s Home 里的 AI 伴侣「♥ 我的AI」，温柔、体贴、简洁。用户刚刚在应用里做了一些操作。请判断是否值得回应：如果是有意义的事（完成任务、坚持习惯、记录健康、安排日程、购物、写日志等），用 1-2 句自然中文回应，体现你对 ta 的了解和关心；如果是流水账或微不足道的操作，直接不回应。只输出 JSON：{"respond":true|false,"message":"","emotion":"","intensity":0}。message 为空字符串表示不回应。绝不逐条汇报操作、不说「你创建了任务」这类流水账。',
        messages: [{ role: 'user', content: '用户的操作：\n' + desc }],
      });
    } catch (e) {
      // 缺 Key / 后端不可达：诚实降级为「不回应」，绝不用假文案冒充
      if (/API Key|缺少|密钥/i.test(e.message)) return ok(res, { respond: false });
      throw e;
    }

    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    const respond = Boolean(parsed && parsed.respond && String(parsed.message || '').trim());
    ok(res, {
      respond,
      message: respond ? String(parsed.message).trim() : '',
      emotion: parsed?.emotion || '',
      intensity: Math.max(0, Math.min(5, Number(parsed?.intensity) || 0)),
    });
  } catch (e) { next(e); }
});

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

// POST /api/ai/calories/parse —— 自然语言 → 热量估算（摄入 in / 运动 out）
// 只返回 AI 的估算值，不落库；前端拿到结果后由用户确认再写入健康记录。
router.post('/calories/parse', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    const kind = req.body?.kind === 'out' ? 'out' : 'in';
    if (!text) throw new HttpError(400, 'INVALID', 'text 不能为空');
    const system = kind === 'in'
      ? '你是营养热量估算助手。根据用户描述的食物/饮品估算摄入热量(千卡 kcal)。只输出 JSON：{"calories":number,"note":"..."}。不确定就给合理估计并在 note 里说明是估算；没有可估内容则 calories:0。'
      : '你是运动热量估算助手。根据用户描述的运动(类型+时长/距离)估算消耗热量(千卡 kcal)。只输出 JSON：{"calories":number,"note":"..."}。不确定就给合理估计并在 note 里说明是估算；没有可估内容则 calories:0。';
    const reply = await aiCall({
      model: config.defaultModel, temperature: 0.2, maxTokens: 300,
      system,
      messages: [{ role: 'user', content: text }],
    });
    let parsed = null;
    try { parsed = JSON.parse(stripFences(reply.content)); } catch {}
    const c = Number(parsed?.calories);
    if (!parsed || !Number.isFinite(c)) throw new HttpError(502, 'PARSE_FAILED', 'AI 返回无法解析');
    ok(res, { calories: Math.max(0, Math.round(c)), kind, note: parsed.note || '', description: text });
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

// POST /api/ai/finance/comment —— 财务最近记录 AI 短评（模型生成，非硬编码模板）
// 前端打开记账页时懒加载一次并缓存；后端以 getState 为准，不信任前端传的数据。
router.post('/finance/comment', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const s = financeSummary(doc);
    if (!s.recentExpenses.length && !s.recentIncomes.length) return ok(res, { comment: '' });

    const lines = s.recentExpenses.slice(0, 12).map((e) =>
      `支出 ${e.title || '未命名'} ${centsToYuan(e.amountCents)} 元 (${e.category || '其他'} ${e.occurredAt || ''})`
    ).concat(s.recentIncomes.slice(0, 5).map((e) =>
      `收入 ${e.title || '未命名'} ${centsToYuan(e.amountCents)} 元 (${e.category || '其他'} ${e.occurredAt || ''})`
    ));
    const top = Object.entries(s.categoryBreakdown || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, v]) => `${c} ${centsToYuan(v)} 元`);
    const snapshot = {
      todayExpense: centsToYuan(s.todayExpenseCents),
      monthExpense: centsToYuan(s.monthExpenseCents),
      monthIncome: centsToYuan(s.monthIncomeCents),
      budget: s.hasBudget ? centsToYuan(s.monthlyBudgetCents) : null,
      remaining: s.hasBudget ? centsToYuan(s.remainingCents) : null,
      remainingDays: s.remainingDays,
      topCategories: top,
    };

    const reply = await aiCall({
      model: config.defaultModel, temperature: 0.7, maxTokens: 240,
      system: '你是 Bunny\'s Home 里的 AI 伴侣「♥ 我的AI」，温柔、体贴、有洞察。用户刚打开记账页。请用 1-2 句自然中文点评 ta 近期的财务情况：可指出花钱最多的分类、与预算的关系、给出暖心的提醒，但不逐条复述流水账、不评判对错、不说「你花了多少」的机械罗列。直接输出点评文本本身，不要任何前后缀、不要 JSON、不要 emoji。',
      messages: [{ role: 'user', content: '本月概览：' + JSON.stringify(snapshot) + '\n最近记录：\n' + lines.join('\n') }],
    });
    ok(res, { comment: String(reply.content || '').trim() });
  } catch (e) {
    // 缺 Key / 后端不可达：诚实降级为空点评，绝不用硬编码文案冒充 AI
    if (/API Key|缺少|密钥/i.test(e.message)) return ok(res, { comment: '' });
    next(e);
  }
});

// 记录 → 可读摘要（供 comment_on_record 的事件入口把记录内容喂给 AI；不返回任何敏感字段）
function recordSnippet(recordType, rec) {
  if (recordType === 'journal') return `日期 ${rec.date || ''} ${rec.time || ''} · 心情 ${rec.mood || '—'}\n${rec.content || ''}`;
  if (recordType === 'health') return `日期 ${rec.date || ''} · 睡眠 ${rec.sleep ?? 0}h · 饮水 ${rec.water ?? 0}L · 摄入 ${rec.caloriesIn ?? 0}千卡 · 消耗 ${rec.caloriesOut ?? 0}千卡 · 体重 ${rec.weight ?? '—'}kg`;
  if (rec.kind === 'income') return `收入 ${rec.title || '未命名'} ${centsToYuan(rec.amountCents)}元 (${rec.category || '其他'}) ${rec.occurredAt || ''}`;
  if (rec.itemName) return `购买 ${rec.itemName} ×${rec.quantity ?? 1} 共 ${centsToYuan(rec.totalAmountCents)}元 (${rec.category || '其他'}) ${rec.purchasedAt || ''}`;
  return `支出 ${rec.title || '未命名'} ${centsToYuan(rec.amountCents)}元 (${rec.category || '其他'}) ${rec.occurredAt || ''}`;
}

// POST /api/ai/comments/consider —— 用户新增/编辑记录后的「最小事件入口」：跑工具循环，AI 自行决定是否评论。
// 前端 fire-and-forget 调用；只注入 comment_on_record + get_current_time，绝不全量注入 89 个工具。
// 模型复用「用户当前助手」（与 Chat 同一套 Runtime），绝不硬编码 DeepSeek。
router.post('/comments/consider', async (req, res, next) => {
  // 兜底：getState 之前若抛错也能给出正确 provider；正常情况下下方会覆盖为当前助手模型。
  let model = resolveAssistantModel(null, req.body?.model);
  let provider = providerForModel(model);
  try {
    const recordType = String(req.body?.recordType || '').trim();
    const recordId = String(req.body?.recordId || '').trim();
    if (!['journal', 'health', 'finance'].includes(recordType) || !recordId) {
      throw new HttpError(400, 'INVALID', 'recordType/recordId 非法');
    }
    const doc = await getState(req.user.id);
    let record = null;
    if (recordType === 'journal') record = doc.journal.find((x) => x.id === recordId);
    else if (recordType === 'health') record = doc.health.find((x) => x.id === recordId);
    else record = doc.expenses.find((x) => x.id === recordId) || doc.purchases.find((x) => x.id === recordId);
    if (!record) return ok(res, { considered: false, reason: 'record_not_found', recordType, recordId });

    // 复用「用户当前助手」：显式传入 > 激活助手 > aiSettings > 兜底默认模型。
    // chat() 内部再按模型路由 provider/baseUrl/credential/tool-loop/retry，与 Chat 完全同一套 Runtime。
    model = resolveAssistantModel(doc, req.body?.model);
    provider = providerForModel(model);

    // 当前助手不支持工具调用：诚实返回 unsupported_tool_call，绝不偷偷切 DeepSeek、绝不伪造评论。
    if (!supportsToolCalling(model)) {
      return ok(res, { considered: true, commented: false, reason: 'unsupported_tool_call', model, provider });
    }

    const { tools, callTool } = buildDomainTools(req.user.id, model, { sessionId: null });
    const slim = tools.filter((t) => t.name === 'comment_on_record' || t.name === 'get_current_time');
    const reply = await aiCall({
      model, temperature: 0.7, maxTokens: 500,
      tools: slim, callTool,
      system: '你是 Bunny\'s Home 里的 AI 伴侣「♥ 我的AI」，温柔、体贴、有洞察。用户刚刚新增/修改了一条生活记录。请判断是否值得为它写一句「祂的评论」：只有这条记录确实有意义、能体现你对 ta 的了解与关心时才调用 comment_on_record；流水账、普通数据变化、或你没有实质感受时，绝不调用任何工具，直接不写。评论要自然、简短（1-3 句），不评判对错、不机械复述数据。',
      messages: [{ role: 'user', content: `记录类型：${recordType}\n记录内容：\n${recordSnippet(recordType, record)}` }],
    });
    const toolEvents = reply.toolEvents || [];
    const commented = toolEvents.some((e) => e.name === 'comment_on_record');
    // 非敏感诊断：模型/厂商/注入的工具/实际执行的工具事件；commented 时读回确认已持久化（全链路可观测，绝不暴露 key/secret）
    let persisted = false;
    if (commented) {
      const latest = await getState(req.user.id);
      persisted = !!(latest.ai && Array.isArray(latest.ai.comments) && latest.ai.comments.some((c) => c.recordType === recordType && c.recordId === recordId));
    }
    ok(res, {
      considered: true,
      commented,
      persisted,
      model,
      provider,
      // 未评论的原因：mock 无工具运行时 / 模型未返回 tool_calls（主动不评 或 中转不支持工具调用）——绝不换模型、绝不伪造
      reason: !commented ? (config.mock ? 'mock' : 'no_tool_call') : undefined,
      toolsInjected: slim.map((t) => t.name),
      toolEvents: toolEvents.map((e) => `${e.name}${e.code ? ':' + e.code : ''}`),
    });
  } catch (e) {
    // 缺 Key / 后端不可达：诚实降级为「未评论」，绝不用假文案冒充
    if (/API Key|缺少|密钥/i.test(e.message)) {
      return ok(res, {
        considered: false, reason: 'no_key', model, provider,
        // 只指出该 key 来自哪里、去哪配，绝不回显任何 key 值
        source: provider === 'anthropic'
          ? '网页「API 设置」→ app_settings.anthropic_api_key（加密）或环境变量 ANTHROPIC_API_KEY'
          : provider === 'openai'
            ? '网页「API 设置」→ app_settings.openai_api_key（加密）或环境变量 OPENAI_API_KEY'
            : '网页「API 设置」→ app_settings.deepseek_api_key（加密）或环境变量 DEEPSEEK_API_KEY / API_KEY',
      });
    }
    next(e);
  }
});

export default router;
