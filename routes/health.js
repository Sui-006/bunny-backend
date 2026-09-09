import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok, pick, requireFields } from '../lib/rest.js';

const router = Router();
const HEALTH_FIELDS = ['date', 'sleep', 'steps', 'heartRate', 'calories', 'water'];
const METRICS = ['sleep', 'steps', 'heartRate', 'calories', 'water'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (s, n) => { const p = s.split('-').map(Number); const d = new Date(p[0], p[1] - 1, p[2] + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let records = doc.health;
    if (req.query.start) records = records.filter((r) => r.date >= req.query.start);
    if (req.query.end) records = records.filter((r) => r.date <= req.query.end);
    records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    ok(res, records);
  } catch (e) { next(e); }
});

// GET /api/health/summary —— 7 天 / 30 天均值
router.get('/summary', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const avg = (days) => {
      const cutoff = addDays(todayStr(), -(days - 1));
      const recs = doc.health.filter((r) => r.date >= cutoff);
      const out = {};
      for (const m of METRICS) {
        const vals = recs.map((r) => Number(r[m])).filter((v) => Number.isFinite(v));
        out[m] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 0;
      }
      return out;
    };
    ok(res, { sevenDay: avg(7), thirtyDay: avg(30) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const r = doc.health.find((x) => x.id === req.params.id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    ok(res, r);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    requireFields(req.body, ['date']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) throw new HttpError(400, 'INVALID', 'date 必须是 YYYY-MM-DD');
    const doc = await getState(req.user.id);
    const record = { id: randomUUID(), date: todayStr(), sleep: 0, steps: 0, heartRate: 0, calories: 0, water: 0, ...pick(req.body, HEALTH_FIELDS) };
    doc.health.push(record);
    await putState(req.user.id, doc);
    ok(res, record, 201);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = pick(req.body, HEALTH_FIELDS);
    const doc = await getState(req.user.id);
    const r = doc.health.find((x) => x.id === req.params.id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    Object.assign(r, patch);
    await putState(req.user.id, doc);
    ok(res, r);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.health = doc.health.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

export default router;
