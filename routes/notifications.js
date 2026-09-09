import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { getAppSettings } from '../lib/db.js';
import { config } from '../lib/config.js';
import { HttpError, ok } from '../lib/rest.js';
import { sendBark } from '../lib/bark.js';
import { composeNotification, toBarkArgs } from '../lib/notify.js';

const router = Router();

// 读取 Bark 地址（网页配置优先，环境变量兜底）
async function resolveBarkUrl() {
  const app = await getAppSettings();
  return app?.bark_url || config.barkUrl || '';
}

// 通知类型归一化；ALARM 必须显式携带 alarmIntent=true 才放行（强提醒安全闸）
function normalizeLevel(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'ALARM') return 'alarm';
  if (t === 'TIME_SENSITIVE') return 'time_sensitive';
  return 'normal';
}

router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    let list = doc.notifications;
    if (req.query.unread !== undefined) list = list.filter((n) => Boolean(n.read) !== (req.query.unread === 'true' || req.query.unread === '1'));
    ok(res, list);
  } catch (e) { next(e); }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const n = doc.notifications.find((x) => x.id === req.params.id);
    if (!n) throw new HttpError(404, 'NOT_FOUND', '通知不存在');
    n.read = req.body?.read !== undefined ? Boolean(req.body.read) : true;
    await putState(req.user.id, doc);
    ok(res, n);
  } catch (e) { next(e); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    for (const n of doc.notifications) n.read = true;
    await putState(req.user.id, doc);
    ok(res, { ok: true });
  } catch (e) { next(e); }
});

// POST /api/notifications/send —— 立即发送一条 Bark 通知。
// body: { title, body, type }。type=alarm（critical）仅在 alarmIntent=true 时放行。
router.post('/send', async (req, res, next) => {
  try {
    const { title, body, type, alarmIntent, sound } = req.body || {};
    const level = normalizeLevel(type);
    if (level === 'alarm' && !req.body?.alarmIntent) {
      throw new HttpError(400, 'NOT_ALARM', '强提醒（critical）仅限用户明确设置的闹钟，需 alarmIntent=true');
    }
    const barkUrl = await resolveBarkUrl();
    const result = await sendBark({
      barkUrl,
      title: String(title || '').slice(0, 120) || '提醒',
      body: String(body || '').slice(0, 500),
      level,
      sound,
    });
    ok(res, { sent: result.sent, level, reason: result.reason });
  } catch (e) { next(e); }
});

// POST /api/notifications/test —— 发送普通测试通知（永远 NORMAL，绝不 critical/call）。
// 标题/正文由 AI 生成，避免硬编码文案。
router.post('/test', async (req, res, next) => {
  try {
    const barkUrl = await resolveBarkUrl();
    if (!barkUrl) throw new HttpError(400, 'NO_BARK_URL', '尚未配置 Bark，请先在设置里填写 Bark 地址');
    const composed = await composeNotification({
      context: '这是一条测试通知。请用自然亲切的中文写一句简短的测试提醒，说明 Bark 通知已连接成功。type=NORMAL。',
    });
    const args = toBarkArgs(composed, { allowAlarm: false });
    const result = await sendBark({
      barkUrl,
      title: args.title || 'Bark 测试',
      body: args.body || 'Bunny’s Home 通知已连接 ✓',
      level: 'normal',
    });
    ok(res, { sent: result.sent, title: args.title, body: args.body, reason: result.reason });
  } catch (e) { next(e); }
});

// POST /api/notifications/compose —— 让 AI 生成一条结构化通知（只生成，不发送），供前端展示/预览
router.post('/compose', async (req, res, next) => {
  try {
    const { context, model } = req.body || {};
    if (!context) throw new HttpError(400, 'INVALID', 'context 不能为空');
    const composed = await composeNotification({ context, model });
    ok(res, composed);
  } catch (e) { next(e); }
});

// ---- 闹钟调度（Asia/Shanghai）----
function shanghaiNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}
function shanghaiDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 判断闹钟此刻是否该响（15 分钟窗口 + lastFired 去重，容忍 cron 延迟）
function alarmShouldFire(a, today, nowMin, dow) {
  if (!a || !a.enabled || a.bark === false) return false;
  const t = a.time;
  const m = timeToMinutes(t);
  if (m == null) return false;
  const WINDOW = 15;
  if (nowMin < m || nowMin >= m + WINDOW) return false;
  if (a.repeat === 'weekdays') { if (dow === 0 || dow === 6) return false; }
  else if (a.repeat === 'custom') { const days = Array.isArray(a.days) ? a.days : []; if (!days.includes(dow)) return false; }
  else if (a.repeat === 'once') { if (a.date && a.date !== today) return false; }
  const last = a.lastFired && a.lastFired[today];
  return !last;
}

// GET /api/notifications/tick —— 调度入口：扫描到期闹钟，AI 创作文案后发送 Bark 强提醒。
// 由前端定时轮询 + GitHub Actions 心跳共同触发；幂等（lastFired 去重）。
router.get('/tick', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    const alarms = doc.alarms || [];
    const barkUrl = await resolveBarkUrl();
    const now = shanghaiNow();
    const today = shanghaiDate(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dow = now.getDay(); // 0=周日 … 6=周六

    const fired = [];
    for (const a of alarms) {
      if (!alarmShouldFire(a, today, nowMin, dow)) continue;
      // AI 创作自然文案；失败则回退到闹钟自带标题/内容
      let title = a.title || '';
      let body = a.body || a.title || '';
      if (barkUrl) {
        const composed = await composeNotification({
          context: `闹钟到点提醒。时间 ${a.time}，标题「${a.title || ''}」，内容「${a.body || ''}」，重复 ${a.repeat}。请生成自然、贴合语境的中文提醒（type=ALARM）。`,
        });
        if (composed && composed.shouldNotify !== false && (composed.title || composed.body)) {
          title = composed.title || title;
          body = composed.body || body;
        }
      }
      const result = await sendBark({ barkUrl, title, body, level: 'alarm' });
      if (result.sent) {
        a.lastFired = a.lastFired || {};
        a.lastFired[today] = Date.now();
        if (a.repeat === 'once') a.enabled = false;
        fired.push({ id: a.id, title });
      }
    }
    if (fired.length) await putState(req.user.id, doc);
    ok(res, { fired: fired.length, list: fired });
  } catch (e) { next(e); }
});

export default router;
