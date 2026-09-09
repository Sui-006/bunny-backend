import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState, defaultPlan, PLAN_TYPES } from '../lib/domain.js';
import { HttpError, ok, pick } from '../lib/rest.js';

const router = Router();
const PLAN_FIELDS = ['title', 'description', 'startDate', 'endDate', 'themeColor', 'parentPlanId', 'archived', 'longGoal', 'stageGoals', 'results'];

// GET /api/plans?type=monthly&archived=false
router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let plans = doc.plans;
    if (req.query.type) plans = plans.filter((p) => p.type === req.query.type);
    if (req.query.archived !== undefined) plans = plans.filter((p) => Boolean(p.archived) === (req.query.archived === 'true'));
    ok(res, plans);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const plan = doc.plans.find((p) => p.id === req.params.id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    ok(res, plan);
  } catch (e) { next(e); }
});

// POST /api/plans —— 新建计划（type 必填，自动套默认标题/颜色）
router.post('/', async (req, res, next) => {
  try {
    const type = req.body?.type;
    if (!PLAN_TYPES.includes(type)) throw new HttpError(400, 'INVALID_TYPE', 'type 非法');
    const doc = await getState(req.user.id);
    const plan = { ...defaultPlan(type), ...pick(req.body, PLAN_FIELDS), type };
    doc.plans.push(plan);
    await putState(req.user.id, doc);
    ok(res, plan, 201);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = pick(req.body, PLAN_FIELDS);
    const doc = await getState(req.user.id);
    const plan = doc.plans.find((p) => p.id === req.params.id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    Object.assign(plan, patch, { updatedAt: Date.now() });
    await putState(req.user.id, doc);
    ok(res, plan);
  } catch (e) { next(e); }
});

// DELETE /api/plans/:id —— 删除；该类型唯一计划删除后自动补空白计划（服务端兜底）
router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const plan = doc.plans.find((p) => p.id === req.params.id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    const type = plan.type;
    doc.plans = doc.plans.filter((p) => p.id !== req.params.id);
    if (!doc.plans.some((p) => p.type === type)) doc.plans.push(defaultPlan(type));
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/plans/:id/duplicate
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const src = doc.plans.find((p) => p.id === req.params.id);
    if (!src) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    const copy = {
      ...src,
      id: randomUUID(),
      title: `${src.title || ''} (副本)`,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stageGoals: (src.stageGoals || []).map((g) => ({ ...g, id: randomUUID() })),
      results: (src.results || []).map((r) => ({ ...r, id: randomUUID() })),
    };
    doc.plans.push(copy);
    await putState(req.user.id, doc);
    ok(res, copy, 201);
  } catch (e) { next(e); }
});

// POST /api/plans/:id/archive —— 切换归档
router.post('/:id/archive', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const plan = doc.plans.find((p) => p.id === req.params.id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    plan.archived = !plan.archived;
    plan.updatedAt = Date.now();
    await putState(req.user.id, doc);
    ok(res, plan);
  } catch (e) { next(e); }
});

// PATCH /api/plans/:id/theme —— 只改主题色（不影响其它计划）
router.patch('/:id/theme', async (req, res, next) => {
  try {
    const color = String(req.body?.themeColor || req.body?.color || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'INVALID', 'themeColor 必须是 #RRGGBB');
    const doc = await getState(req.user.id);
    const plan = doc.plans.find((p) => p.id === req.params.id);
    if (!plan) throw new HttpError(404, 'NOT_FOUND', '计划不存在');
    plan.themeColor = color;
    plan.updatedAt = Date.now();
    await putState(req.user.id, doc);
    ok(res, plan);
  } catch (e) { next(e); }
});

export default router;
