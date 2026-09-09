import { Router } from 'express';
import { listPlans, createPlan, updatePlan, deletePlan } from '../lib/db.js';

// 旧版「待办 / 本月 / 年度」计划板（已被四级计划取代，保留兼容，挂载在 /api/plans-board）
const router = Router();
const CATEGORIES = ['todo', 'month', 'year'];

router.get('/', async (req, res, next) => {
  try {
    const plans = await listPlans();
    res.json({ plans });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const category = req.body?.category;
    const content = (req.body?.content || '').trim();
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'category 非法' });
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    const plan = await createPlan({ category, content });
    res.status(201).json({ plan });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { content, done } = req.body || {};
    const patch = {};
    if (content !== undefined) {
      const c = String(content).trim();
      if (!c) return res.status(400).json({ error: 'content 不能为空' });
      patch.content = c;
    }
    if (done !== undefined) patch.done = Boolean(done);
    const plan = await updatePlan(req.params.id, patch);
    res.json({ plan });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await deletePlan(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
