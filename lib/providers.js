import { config } from './config.js';
import { getAppSettings, saveAppSettings } from './db.js';
import { EncryptionService } from './crypto.js';

// 厂商连接服务（ProviderConnectionService）
// 连接状态必须来自对厂商 API 的真实请求，绝不根据「key 是否存在」推断成功。
// 状态：CONNECTED / DISCONNECTED / PENDING / FAILED / REQUIRES_PERMISSION / UNSUPPORTED
// 错误码：INVALID_API_KEY / BACKEND_UNAVAILABLE / PROVIDER_UNAVAILABLE / NETWORK_ERROR /
//         DATABASE_ERROR / CREDENTIAL_NOT_CONFIGURED / PERMISSION_DENIED / UNSUPPORTED / UNKNOWN_ERROR

export const PROVIDERS = ['deepseek', 'openai', 'anthropic'];

export const PROVIDER_META = {
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-compat' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-compat' },
  anthropic: { label: 'Anthropic', model: 'claude-3-5-haiku-latest', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' },
};

const CONN_COLUMNS = {
  deepseek: ['deepseek_conn_status', 'deepseek_conn_at'],
  openai: ['openai_conn_status', 'openai_conn_at'],
  anthropic: ['anthropic_conn_status', 'anthropic_conn_at'],
};

// 从错误信息中剥离疑似密钥，避免把 secret 写进响应/日志
function sanitize(text) {
  return String(text || '')
    .replace(/(sk-[A-Za-z0-9_-]{4,})/gi, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(x-api-key[=:]\s*)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .slice(0, 200);
}

function result(status, code, message) {
  return { status, code: code || null, message: message || '' };
}

// 读取某厂商的解密后凭据（网页配置优先，环境变量兜底）
export async function resolveProviderCredential(provider) {
  const app = await getAppSettings();
  const meta = PROVIDER_META[provider];
  if (!meta) return { provider, apiKey: '', baseUrl: '', protocol: '' };

  if (provider === 'anthropic') {
    return {
      provider,
      apiKey: EncryptionService.decrypt(app?.anthropic_api_key) || config.anthropicApiKey,
      baseUrl: app?.anthropic_base_url || config.anthropicBaseUrl || meta.baseUrl,
      protocol: app?.anthropic_protocol || config.anthropicProtocol || meta.protocol,
    };
  }
  if (provider === 'openai') {
    return {
      provider,
      apiKey: EncryptionService.decrypt(app?.openai_api_key) || config.openaiApiKey,
      baseUrl: app?.openai_base_url || config.openaiBaseUrl || meta.baseUrl,
      protocol: 'openai-compat',
    };
  }
  return {
    provider,
    apiKey: EncryptionService.decrypt(app?.deepseek_api_key) || config.deepseekApiKey,
    baseUrl: app?.deepseek_base_url || config.deepseekBaseUrl || meta.baseUrl,
    protocol: 'openai-compat',
  };
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// 实际测试连接：OpenAI 兼容协议用 GET /models（零成本、只看 key 是否有效）；
// Anthropic 原生协议用一次 max_tokens=1 的最小消息请求。
async function testConnection(cred) {
  const base = String(cred.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(cred.apiKey || '');
  if (cred.protocol === 'anthropic') {
    return fetchWithTimeout(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cred.model || PROVIDER_META.anthropic.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    }, 15000);
  }
  return fetchWithTimeout(`${base}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 15000);
}

function mapHttp(res) {
  if (res.ok) return result('CONNECTED', 'OK');
  const status = res.status;
  if (status === 401) return result('FAILED', 'INVALID_API_KEY', 'API Key 无效或已被撤销');
  if (status === 403) return result('FAILED', 'PERMISSION_DENIED', 'API Key 没有访问权限');
  if (status === 429) return result('FAILED', 'PROVIDER_UNAVAILABLE', '触发限流，请稍后再试');
  if (status >= 500) return result('DISCONNECTED', 'PROVIDER_UNAVAILABLE', '服务商暂时不可用');
  return result('FAILED', 'UNKNOWN_ERROR', `服务商返回 HTTP ${status}`);
}

async function cacheResult(provider, r) {
  const cols = CONN_COLUMNS[provider];
  if (!cols) return;
  try {
    await saveAppSettings({ [cols[0]]: r.status, [cols[1]]: new Date().toISOString() });
  } catch {
    // 缓存失败不影响测试结果返回
  }
}

// 读取缓存的上次测试结果（status + 时间），无缓存返回 null
export function readCachedConnection(app, provider) {
  const cols = CONN_COLUMNS[provider];
  if (!cols || !app) return null;
  const status = app[cols[0]];
  if (!status) return null;
  return { status, testedAt: app[cols[1]] || null };
}

export const ProviderConnectionService = {
  // 测试厂商连接。opts 可覆盖凭据（用于「测试未保存的新 key」）。
  // 返回 { provider, status, code, message, testedAt }
  async test(provider, opts = {}) {
    if (!PROVIDER_META[provider]) return { provider, ...result('UNSUPPORTED', 'UNSUPPORTED', '未知厂商') };

    const cred = {
      provider,
      apiKey: opts.apiKey != null ? opts.apiKey : '',
      baseUrl: opts.baseUrl || '',
      protocol: opts.protocol || '',
      model: opts.model || '',
    };
    // 未显式传入 key 时，用已保存/环境变量的凭据
    if (opts.apiKey == null) {
      const saved = await resolveProviderCredential(provider);
      cred.apiKey = saved.apiKey;
      cred.baseUrl = opts.baseUrl || saved.baseUrl;
      cred.protocol = opts.protocol || saved.protocol;
      cred.model = opts.model || PROVIDER_META[provider].model;
    } else {
      cred.baseUrl = cred.baseUrl || PROVIDER_META[provider].baseUrl;
      cred.protocol = cred.protocol || (provider === 'anthropic' ? 'anthropic' : 'openai-compat');
      cred.model = cred.model || PROVIDER_META[provider].model;
    }

    if (!cred.apiKey) {
      const r = { provider, ...result('DISCONNECTED', 'CREDENTIAL_NOT_CONFIGURED', '未配置 API Key') };
      await cacheResult(provider, r);
      return r;
    }

    let r;
    try {
      const res = await testConnection(cred);
      r = { provider, ...mapHttp(res) };
    } catch (e) {
      const isTimeout = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      r = { provider, ...result('DISCONNECTED', 'NETWORK_ERROR', isTimeout ? '连接超时' : '无法连接服务商') };
    }
    r.testedAt = new Date().toISOString();
    await cacheResult(provider, r);
    return r;
  },
};
