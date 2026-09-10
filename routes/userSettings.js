import { Router } from 'express';
import { getState, putState } from '../lib/domain.js';
import { ok, pick } from '../lib/rest.js';

const router = Router();
const APPER = ['theme', 'accent', 'font', 'wallpaper'];
const AI = ['aiName', 'assistantAvatar', 'assistantAvatarUrl', 'bubbleOpacity', 'model', 'systemPrompt', 'streaming', 'memory', 'autoCompress'];
const NOTIF = ['morning', 'morningTime', 'noon', 'noonTime', 'night', 'nightTime', 'idle', 'idleHours', 'replyNotify'];

// GET /api/user-settings —— 外观 / AI / 通知 / 应用名
router.get('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    ok(res, { appName: doc.appName, appearance: doc.appearance, aiSettings: doc.aiSettings, notifSettings: doc.notifSettings });
  } catch (e) { next(e); }
});

// PATCH /api/user-settings —— 按需更新四个区块
router.patch('/', async (req, res, next) => {
  try {
    const doc = await getState(req.user.id);
    if (req.body?.appName !== undefined) doc.appName = String(req.body.appName);
    if (req.body?.appearance) Object.assign(doc.appearance, pick(req.body.appearance, APPER));
    if (req.body?.aiSettings) Object.assign(doc.aiSettings, pick(req.body.aiSettings, AI));
    if (req.body?.notifSettings) Object.assign(doc.notifSettings, pick(req.body.notifSettings, NOTIF));
    await putState(req.user.id, doc);
    ok(res, { appName: doc.appName, appearance: doc.appearance, aiSettings: doc.aiSettings, notifSettings: doc.notifSettings });
  } catch (e) { next(e); }
});

export default router;
