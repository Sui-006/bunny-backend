import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState, habitStreak } from '../lib/domain.js';
import { HttpError, ok, pick, requireFields } from '../lib/rest.js';

const router = Router();
const HABIT_FIELDS = ['name', 'icon', 'color', 'frequency', 'goal', 'reminderTime'];
const FREQS = ['daily', 'weekdays', 'weekly', 'custom'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

router.get('/', async (req, res, next) => {
  try { ok(res, await (await getState(req.user.id)).habits); } catch (e) { next(e); }
});

router.get('/:id/streak', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const h = doc.habits.find((x) => x.id === req.params.id);
    if (!h) throw new HttpError(404, 'NOT_FOUND', '习惯不存在');
    const streak = habitStreak(h.completions);
    const longest = Math.max(streak, h.streak || 0);
    ok(res, { streak, longest });
  } catch (e) { next(e); }
});

router.get('/:id/history', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const h = doc.habits.find((x) => x.id === req.params.id);
    if (!h) throw new HttpError(404, 'NOT_FOUND', '习惯不存在');
    ok(res, { completions: h.completions || [], streak: habitStreak(h.completions) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const h = doc.habits.find((x) => x.id === req.params.id);
    if (!h) throw new HttpError(404, 'NOT_FOUND', '习惯不存在');
    ok(res, h);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    requireFields(req.body, ['name']);
    if (req.body.frequency && !FREQS.includes(req.body.frequency)) throw new HttpError(400, 'INVALID', 'frequency 非法');
    const doc = await getState(req.user.id);
    const habit = {
      id: randomUUID(), name: '', icon: '✅', color: '#6b8cae', frequency: 'daily', goal: 1,
      reminderTime: '', completions: [], streak: 0, createdAt: Date.now(),
      ...pick(req.body, HABIT_FIELDS),
    };
    doc.habits.push(habit);
    await putState(req.user.id, doc);
    ok(res, habit, 201);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = pick(req.body, HABIT_FIELDS);
    if (patch.frequency && !FREQS.includes(patch.frequency)) throw new HttpError(400, 'INVALID', 'frequency 非法');
    const doc = await getState(req.user.id);
    const h = doc.habits.find((x) => x.id === req.params.id);
    if (!h) throw new HttpError(404, 'NOT_FOUND', '习惯不存在');
    Object.assign(h, patch);
    await putState(req.user.id, doc);
    ok(res, h);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.habits = doc.habits.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/habits/:id/complete —— 打卡/取消（date 默认今天）
router.post('/:id/complete', async (req, res, next) => {
  try {
    const date = req.body?.date || todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'INVALID', 'date 必须是 YYYY-MM-DD');
    const doc = await getState(req.user.id);
    const h = doc.habits.find((x) => x.id === req.params.id);
    if (!h) throw new HttpError(404, 'NOT_FOUND', '习惯不存在');
    const completions = h.completions || [];
    const i = completions.indexOf(date);
    if (i >= 0) completions.splice(i, 1); else completions.push(date);
    h.completions = completions;
    h.streak = habitStreak(completions);
    await putState(req.user.id, doc);
    ok(res, { habit: h, done: i < 0, streak: h.streak });
  } catch (e) { next(e); }
});

export default router;
