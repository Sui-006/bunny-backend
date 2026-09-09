import { Router } from 'express';
import { getState } from '../lib/domain.js';
import { ok } from '../lib/rest.js';

const router = Router();

// GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// 聚合指定区间的任务 / 健康记录 / 计划（前端日历用真实后端数据）
router.get('/', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    const doc = await getState(req.user.id);

    let tasks = doc.tasks;
    if (start) tasks = tasks.filter((t) => t.date >= start);
    if (end) tasks = tasks.filter((t) => t.date <= end);

    let health = doc.health;
    if (start) health = health.filter((r) => r.date >= start);
    if (end) health = health.filter((r) => r.date <= end);

    const plans = doc.plans.filter((p) => {
      if (!start && !end) return true;
      // 计划区间与查询区间有交集
      if (p.endDate && start && p.endDate < start) return false;
      if (p.startDate && end && p.startDate > end) return false;
      return true;
    });

    ok(res, { start: start || null, end: end || null, tasks, health, plans });
  } catch (e) { next(e); }
});

export default router;
