import { Router } from 'express';
import { listPlans, createPlan, updatePlan, deletePlan } from '../lib/db.js';

const router = Router();
const CATEGORIES = ['todo', 'month', 'year'];

// GET /api/plans —— 全部计划（前端按 category 分组）
router.get('/', async (req, res, next) => {
  try {
    const plans = await listPlans();
    res.json({ plans });
  } catch (e) {
    next(e);
  }
});

// POST /api/plans —— 新增一条计划
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

// PATCH /api/plans/:id —— 改内容 / 标记完成
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

// DELETE /api/plans/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await deletePlan(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
