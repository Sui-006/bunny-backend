import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/ai.js';
import { config } from '../lib/config.js';
import { getState, putState, defaultPlan } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';

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

export default router;
