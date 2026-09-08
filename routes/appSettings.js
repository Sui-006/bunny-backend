import { Router } from 'express';
import { getAppSettings, saveAppSettings } from '../lib/db.js';

const router = Router();

const KEY_FIELDS = ['deepseek_api_key', 'openai_api_key', 'anthropic_api_key'];
const BOOL_FIELDS = ['proactive_morning_enabled', 'proactive_noon_enabled', 'proactive_night_enabled', 'proactive_idle_enabled', 'reply_notify_enabled'];
const INT_NULL_FIELDS = ['proactive_idle_hours'];
const FIELDS = [
  'personal_signature',
  'deepseek_api_key',
  'deepseek_base_url',
  'openai_api_key',
  'openai_base_url',
  'anthropic_api_key',
  'anthropic_base_url',
  'anthropic_protocol',
  'proactive_morning_enabled',
  'proactive_morning_time',
  'proactive_noon_enabled',
  'proactive_noon_time',
  'proactive_night_enabled',
  'proactive_night_time',
  'proactive_idle_enabled',
  'proactive_idle_hours',
  'bark_url',
  'reply_notify_enabled',
];

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

// GET /api/settings —— 全局设置（API key 只返回打码值，永不返回明文）
router.get('/', async (req, res, next) => {
  try {
    const s = (await getAppSettings()) || {};
    res.json({
      settings: {
        personal_signature: s.personal_signature || '',
        deepseek_base_url: s.deepseek_base_url || '',
        openai_base_url: s.openai_base_url || '',
        anthropic_base_url: s.anthropic_base_url || '',
        anthropic_protocol: s.anthropic_protocol || 'anthropic',
        proactive_morning_enabled: s.proactive_morning_enabled !== false,
        proactive_morning_time: s.proactive_morning_time || '08:00',
        proactive_noon_enabled: s.proactive_noon_enabled !== false,
        proactive_noon_time: s.proactive_noon_time || '12:00',
        proactive_night_enabled: s.proactive_night_enabled !== false,
        proactive_night_time: s.proactive_night_time || '22:00',
        proactive_idle_enabled: Boolean(s.proactive_idle_enabled),
        proactive_idle_hours: s.proactive_idle_hours ?? null,
        bark_url: s.bark_url || '',
        reply_notify_enabled: s.reply_notify_enabled !== false,
        deepseek_api_key: maskKey(s.deepseek_api_key),
        openai_api_key: maskKey(s.openai_api_key),
        anthropic_api_key: maskKey(s.anthropic_api_key),
        deepseek_key_set: Boolean(s.deepseek_api_key),
        openai_key_set: Boolean(s.openai_api_key),
        anthropic_key_set: Boolean(s.anthropic_api_key),
      },
    });
  } catch (e) {
    next(e);
  }
});

// PUT /api/settings —— 更新全局设置（打码的 key 不回写，避免覆盖真实值）
router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const partial = {};
    for (const key of FIELDS) {
      if (body[key] === undefined) continue;
      if (KEY_FIELDS.includes(key)) {
        const v = String(body[key]).trim();
        if (!v || v.includes('•')) continue; // 空或打码占位：跳过，保留原 key
        partial[key] = v;
      } else if (BOOL_FIELDS.includes(key)) {
        partial[key] = Boolean(body[key]);
      } else if (INT_NULL_FIELDS.includes(key)) {
        const v = body[key];
        if (v === null || v === '' || v === undefined) partial[key] = null;
        else {
          const n = Number(v);
          partial[key] = Number.isFinite(n) ? n : null;
        }
      } else {
        partial[key] = body[key];
      }
    }
    await saveAppSettings(partial);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
