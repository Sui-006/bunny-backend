import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getState, putState } from '../lib/domain.js';
import { HttpError, ok, pick, requireFields } from '../lib/rest.js';

const router = Router();
// 健康记录字段：睡眠(小时)/饮水(升)/摄入热量(千卡)/运动消耗(千卡)/体重(kg)。
// 已按需求移除 steps / heartRate / 旧 calories 字段。
const HEALTH_FIELDS = ['date', 'sleep', 'water', 'caloriesIn', 'caloriesOut', 'weight'];
const METRICS = ['sleep', 'water', 'caloriesIn', 'caloriesOut', 'weight'];
const MEDICAL_TYPES = ['过敏史', '疾病', '就诊', '检查', '手术', '用药', '其他'];
const MEDICAL_FIELDS = ['title', 'type', 'date', 'hospital', 'doctor', 'diagnosis', 'symptoms', 'treatment', 'medication', 'notes', 'source'];
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

// ---- 健康档案：身高（单一值，cm） ----
router.get('/profile', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, doc.healthProfile || { height: null });
  } catch (e) { next(e); }
});

router.put('/profile', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const height = Number(req.body?.height);
    if (height != null && !Number.isFinite(height)) throw new HttpError(400, 'INVALID', 'height 必须是数字');
    doc.healthProfile = { ...(doc.healthProfile || {}), height: height != null && height > 0 ? height : null };
    await putState(req.user.id, doc);
    ok(res, doc.healthProfile);
  } catch (e) { next(e); }
});

// ---- 个人病历（隐私：requireAuth 按用户隔离，绝不进入公共搜索/日志） ----
router.get('/medical-records', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let list = doc.medicalRecords.slice().sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
    if (req.query.type) list = list.filter((r) => r.type === req.query.type);
    ok(res, list);
  } catch (e) { next(e); }
});

router.post('/medical-records', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let fields;
    if (req.body?.text && !req.body?.title) {
      // 自由文本：形如 `2026-09-10 感冒 发烧、咳嗽 备注：休息两天`
      const t = String(req.body.text).trim();
      const dm = t.match(/^(\d{4}-\d{2}-\d{2})\s+/);
      const date = dm ? dm[1] : todayStr();
      const rest = dm ? t.slice(dm[0].length) : t;
      const noteM = rest.match(/备注[:：]\s*(.+)$/);
      const notes = noteM ? noteM[1] : (req.body.notes || '');
      const body = noteM ? rest.slice(0, noteM.index).trim() : rest;
      fields = {
        title: req.body.title || body.split(/[，,。\s]/)[0] || body,
        type: req.body.type || '就诊',
        date,
        diagnosis: req.body.diagnosis || body,
        symptoms: req.body.symptoms || '',
        notes,
        source: req.body.source || 'user',
      };
    } else {
      if (!req.body?.title) throw new HttpError(400, 'MISSING_FIELDS', '缺少字段: title');
      fields = pick(req.body, MEDICAL_FIELDS);
    }
    if (fields.type && !MEDICAL_TYPES.includes(fields.type)) fields.type = '其他';
    const record = {
      id: randomUUID(), title: fields.title || '健康记录', type: fields.type || '其他',
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.date || '')) ? fields.date : todayStr(),
      hospital: fields.hospital || '', doctor: fields.doctor || '',
      diagnosis: fields.diagnosis || '', symptoms: fields.symptoms || '',
      treatment: fields.treatment || '', medication: fields.medication || '',
      notes: fields.notes || '', source: fields.source || 'user',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    doc.medicalRecords.push(record);
    await putState(req.user.id, doc);
    ok(res, record, 201);
  } catch (e) { next(e); }
});

router.patch('/medical-records/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const r = doc.medicalRecords.find((x) => x.id === req.params.id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    const patch = pick(req.body, MEDICAL_FIELDS);
    if (patch.type && !MEDICAL_TYPES.includes(patch.type)) delete patch.type;
    Object.assign(r, patch, { updatedAt: Date.now() });
    await putState(req.user.id, doc);
    ok(res, r);
  } catch (e) { next(e); }
});

router.delete('/medical-records/:id', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    doc.medicalRecords = doc.medicalRecords.filter((x) => x.id !== req.params.id);
    await putState(req.user.id, doc);
    ok(res, { ok: true });
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
    const record = { id: randomUUID(), date: todayStr(), sleep: 0, water: 0, caloriesIn: 0, caloriesOut: 0, weight: null, ...pick(req.body, HEALTH_FIELDS) };
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
