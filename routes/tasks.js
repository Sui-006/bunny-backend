import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState, planChain } from '../lib/domain.js';
import { HttpError, ok, pick, requireFields } from '../lib/rest.js';

const router = Router();
const TASK_FIELDS = ['title', 'date', 'time', 'completed', 'priority', 'note', 'tags', 'planId', 'weeklyPlanId', 'monthlyPlanId', 'stagePlanId', 'longTermPlanId', 'order'];
const PRIORITIES = ['high', 'med', 'low'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// GET /api/tasks?date=YYYY-MM-DD&completed=0|1
router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let tasks = doc.tasks;
    if (req.query.date) tasks = tasks.filter((t) => t.date === req.query.date);
    if (req.query.completed !== undefined) tasks = tasks.filter((t) => Boolean(t.completed) === (req.query.completed === 'true' || req.query.completed === '1'));
    ok(res, tasks);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const task = doc.tasks.find((t) => t.id === req.params.id);
    if (!task) throw new HttpError(404, 'NOT_FOUND', '任务不存在');
    ok(res, task);
  } catch (e) { next(e); }
});

// POST /api/tasks —— 新建（title 必填；planId 自动填充四级计划链）
router.post('/', async (req, res, next) => {
  try {
    requireFields(req.body, ['title']);
    const doc = await getState(req.user.id);
    const chain = req.body.planId ? planChain(doc, req.body.planId) : {};
    if (req.body.priority && !PRIORITIES.includes(req.body.priority)) throw new HttpError(400, 'INVALID', 'priority 非法');
    const task = {
      id: randomUUID(), planId: null, weeklyPlanId: null, monthlyPlanId: null, stagePlanId: null, longTermPlanId: null,
      order: Date.now(), createdAt: Date.now(), date: todayStr(), time: '', completed: false, priority: 'med', note: '', tags: [],
      ...pick(req.body, TASK_FIELDS), ...chain,
    };
    doc.tasks.push(task);
    await putState(req.user.id, doc);
    ok(res, task, 201);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = pick(req.body, TASK_FIELDS);
    if (patch.priority && !PRIORITIES.includes(patch.priority)) throw new HttpError(400, 'INVALID', 'priority 非法');
    const doc = await getState(req.user.id);
    const task = doc.tasks.find((t) => t.id === req.params.id);
    if (!task) throw new HttpError(404, 'NOT_FOUND', '任务不存在');
    Object.assign(task, patch);
    await putState(req.user.id, doc);
    ok(res, task);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.tasks = doc.tasks.filter((t) => t.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/tasks/:id/complete —— 切换完成
router.post('/:id/complete', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const task = doc.tasks.find((t) => t.id === req.params.id);
    if (!task) throw new HttpError(404, 'NOT_FOUND', '任务不存在');
    task.completed = req.body?.completed !== undefined ? Boolean(req.body.completed) : !task.completed;
    await putState(req.user.id, doc);
    ok(res, task);
  } catch (e) { next(e); }
});

// PATCH /api/tasks/:id/date —— 改日期（日历拖动）
router.patch('/:id/date', async (req, res, next) => {
  try {
    const date = String(req.body?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'INVALID', 'date 必须是 YYYY-MM-DD');
    const doc = await getState(req.user.id);
    const task = doc.tasks.find((t) => t.id === req.params.id);
    if (!task) throw new HttpError(404, 'NOT_FOUND', '任务不存在');
    task.date = date;
    await putState(req.user.id, doc);
    ok(res, task);
  } catch (e) { next(e); }
});

// PATCH /api/tasks/reorder —— 批量重排（ids 顺序即新顺序）
router.patch('/reorder', async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'INVALID', 'ids 必须是数组');
    const doc = await getState(req.user.id);
    const orderMap = new Map(ids.map((id, i) => [id, i]));
    for (const t of doc.tasks) if (orderMap.has(t.id)) t.order = orderMap.get(t.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
