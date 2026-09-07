import { Router } from 'express';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/db.js';

const router = Router();
const WHITELIST = Object.keys(DEFAULT_SETTINGS);

// GET /api/sessions/:sessionId/settings —— 读取会话设置（未设置时返回默认值）
router.get('/:sessionId/settings', async (req, res, next) => {
  try {
    const settings = { ...DEFAULT_SETTINGS, ...((await getSettings(req.params.sessionId)) || {}) };
    res.json({ settings });
  } catch (e) {
    next(e);
  }
});

// PUT /api/sessions/:sessionId/settings —— 更新会话设置（只接受白名单字段）
router.put('/:sessionId/settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    const partial = {};
    for (const key of WHITELIST) {
      if (body[key] !== undefined) partial[key] = body[key];
    }
    const settings = await saveSettings(req.params.sessionId, partial);
    res.json({ settings });
  } catch (e) {
    next(e);
  }
});

export default router;
