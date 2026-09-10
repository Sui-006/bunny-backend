import { Router } from 'express';
import { getAppSettings, saveAppSettings } from '../lib/db.js';
import { EncryptionService } from '../lib/crypto.js';
import { HttpError } from '../lib/rest.js';
import { ProviderConnectionService, readCachedConnection, PROVIDERS } from '../lib/providers.js';

const router = Router();

const KEY_FIELDS = ['deepseek_api_key', 'openai_api_key', 'anthropic_api_key'];
// Bark 地址含 device token，视同密钥：不打码、不落前端，PUT 时打码值跳过不回写
const SECRET_URL_FIELDS = ['bark_url'];
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
  'mcp_servers',
];

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

// Bark 地址形如 https://api.day.app/{token}，只暴露末尾 4 位
function maskBarkUrl(u) {
  if (!u) return '';
  const token = String(u).split('/').filter(Boolean).pop() || '';
  if (!token) return '••••••••';
  if (token.length <= 8) return '••••••••';
  return '••••••••' + token.slice(-4);
}

// GET /api/settings —— 全局设置（API key 只返回打码值，永不返回明文）
router.get('/', async (req, res, next) => {
  try {
    const s = (await getAppSettings()) || {};
    const connections = {};
    for (const p of PROVIDERS) connections[p] = readCachedConnection(s, p);
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
        bark_set: Boolean(s.bark_url),
        bark_url: maskBarkUrl(s.bark_url),
        reply_notify_enabled: s.reply_notify_enabled !== false,
        mcp_servers: (() => { try { return JSON.parse(s.mcp_servers || '[]'); } catch { return []; } })(),
        deepseek_api_key: maskKey(EncryptionService.decrypt(s.deepseek_api_key)),
        openai_api_key: maskKey(EncryptionService.decrypt(s.openai_api_key)),
        anthropic_api_key: maskKey(EncryptionService.decrypt(s.anthropic_api_key)),
        deepseek_key_set: Boolean(s.deepseek_api_key),
        openai_key_set: Boolean(s.openai_api_key),
        anthropic_key_set: Boolean(s.anthropic_api_key),
      },
      connections,
    });
  } catch (e) {
    next(e);
  }
});

// PUT /api/settings —— 更新全局设置（打码的 key 不回写；明文 key 加密后落库）
router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const partial = {};
    for (const key of FIELDS) {
      if (body[key] === undefined) continue;
      if (KEY_FIELDS.includes(key)) {
        const v = String(body[key]).trim();
        if (!v || v.includes('•')) continue; // 空或打码占位：跳过，保留原 key
        if (!EncryptionService.available) {
          throw new HttpError(500, 'CREDENTIAL_NOT_CONFIGURED', '服务器未配置 ENCRYPTION_KEY，无法安全保存 API Key');
        }
        partial[key] = EncryptionService.encrypt(v);
      } else if (SECRET_URL_FIELDS.includes(key)) {
        const v = String(body[key]).trim();
        if (!v || v.includes('•')) continue; // 空或打码占位：跳过，保留原 Bark 地址
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
      } else if (key === 'mcp_servers') {
        partial[key] = JSON.stringify(Array.isArray(body[key]) ? body[key] : []);
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

// POST /api/settings/connect —— 真实测试某厂商连接（不保存 key，可传入未保存的 key 预览）
// body: { provider, api_key?, base_url?, protocol?, model? }
router.post('/connect', async (req, res, next) => {
  try {
    const { provider, api_key, base_url, protocol, model } = req.body || {};
    if (!provider) throw new HttpError(400, 'MISSING_FIELDS', '缺少字段: provider');
    const opts = {};
    const rawKey = api_key != null ? String(api_key).trim() : '';
    if (rawKey && !rawKey.includes('•')) opts.apiKey = rawKey;
    if (base_url != null) opts.baseUrl = String(base_url).trim();
    if (protocol != null) opts.protocol = String(protocol).trim();
    if (model != null) opts.model = String(model).trim();
    const connection = await ProviderConnectionService.test(provider, opts);
    res.json({ success: true, connection });
  } catch (e) {
    next(e);
  }
});

export default router;
