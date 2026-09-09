import { Router } from 'express';
import { getState, planProgress } from '../lib/domain.js';
import { ok } from '../lib/rest.js';

const router = Router();
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dstr(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dstr(d); };

// GET /api/statistics?range=7d|30d|90d
router.get('/', async (req, res, next) => {
  try {
    const range = ['7d', '30d', '90d'].includes(req.query.range) ? req.query.range : '7d';
    const days = parseInt(range);
    const cutoff = addDays(-(days - 1));
    const doc = await getState(req.user.id);

    const tasksIn = doc.tasks.filter((t) => t.date >= cutoff && t.date <= todayStr());
    const taskCompletion = tasksIn.length ? Math.round((tasksIn.filter((t) => t.completed).length / tasksIn.length) * 100) : 0;

    const habitTotal = doc.habits.length * days;
    let habitDone = 0;
    for (const h of doc.habits) for (const c of h.completions || []) if (c >= cutoff && c <= todayStr()) habitDone++;
    const habitCompletion = habitTotal ? Math.round((habitDone / habitTotal) * 100) : 0;

    const active = doc.plans.filter((p) => !p.archived);
    const planCompletion = active.length ? Math.round(active.reduce((a, p) => a + planProgress(p), 0) / active.length) : 0;

    const dailyTaskStats = [], dailyHabitStats = [], dailyHealthStats = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(-i);
      const dt = doc.tasks.filter((t) => t.date === d);
      dailyTaskStats.push({ date: d, total: dt.length, completed: dt.filter((t) => t.completed).length });
      let hd = 0;
      for (const h of doc.habits) if ((h.completions || []).includes(d)) hd++;
      dailyHabitStats.push({ date: d, done: hd, total: doc.habits.length });
      const hr = doc.health.find((r) => r.date === d);
      dailyHealthStats.push({ date: d, steps: hr?.steps || 0, sleep: hr?.sleep || 0, heartRate: hr?.heartRate || 0, calories: hr?.calories || 0, water: hr?.water || 0 });
    }

    ok(res, { range, taskCompletion, habitCompletion, planCompletion, dailyTaskStats, dailyHabitStats, dailyHealthStats });
  } catch (e) { next(e); }
});

export default router;
