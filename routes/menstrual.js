// 经期记录与预测（健康隐私，requireAuth 按用户隔离）。
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok } from '../lib/rest.js';
import { todayStr, startCycle, endCycle, withCycleLengths, predict, dayStatus } from '../lib/menstrual.js';

const router = Router();

function normDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : todayStr(); }

// GET /api/menstrual/cycles —— 全部周期（含回填的周期长度）
router.get('/cycles', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, withCycleLengths(doc.menstrualCycles));
  } catch (e) { next(e); }
});

// POST /api/menstrual/start —— 经期开始（幂等：已进行中则返回该周期）
router.post('/start', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const date = normDate(req.body?.date);
    const { cycle, created } = startCycle(doc.menstrualCycles, date);
    if (created) {
      cycle.id = randomUUID();
      doc.menstrualCycles.push(cycle);
      await putState(req.user.id, doc);
    }
    ok(res, { cycle, created }, created ? 201 : 200);
  } catch (e) { next(e); }
});

// POST /api/menstrual/end —— 经期结束（关闭进行中周期）
router.post('/end', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const date = normDate(req.body?.date);
    const { cycle, closed } = endCycle(doc.menstrualCycles, date);
    if (!closed) throw new HttpError(409, 'CONFLICT', '没有进行中的经期');
    await putState(req.user.id, doc);
    ok(res, { cycle, closed: true });
  } catch (e) { next(e); }
});

// DELETE /api/menstrual/:id —— 删除一条周期记录
router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.menstrualCycles = doc.menstrualCycles.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// GET /api/menstrual/prediction —— 预测 + 日历标记
router.get('/prediction', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const pred = predict(doc.menstrualCycles, todayStr());
    // 前端日历需要某日期的状态（start/end/in/predicted），按需在 ?from=..&to=.. 时给出
    let marks = null;
    if (req.query.from && req.query.to) {
      marks = [];
      const d0 = new Date(req.query.from), d1 = new Date(req.query.to);
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
        const s = dstrLocal(d);
        const st = dayStatus(doc.menstrualCycles, pred, s);
        if (st) marks.push({ date: s, status: st });
      }
    }
    ok(res, { ...pred, cycles: withCycleLengths(doc.menstrualCycles), marks });
  } catch (e) { next(e); }
});

function dstrLocal(d) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default router;
