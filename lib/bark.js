// Bark 推送服务：统一构造 URL + 发送。
// 通知级别 → Bark 参数（关键：普通通知绝不使用 critical/volume/call）：
//   normal          → isArchive=1&group=bunny-home
//   time_sensitive  → level=timeSensitive&isArchive=1&group=bunny-home
//   alarm（强提醒） → level=critical&volume=5&call=1&isArchive=1&group=bunny-alarm
//
// 只有用户明确「设闹钟 / 强提醒」时才允许 level=critical / volume=5 / call=1。
//
// icon 规则：永远来自「当前助手头像」的公网 URL，不由 AI 决定、不硬编码。
// 无头像 / 头像非公网 URL（data:/blob:/localhost）时自动省略 icon，Bark 用默认图标。

import { ensureOwner } from './auth.js';
import { getState } from './domain.js';

const LEVEL_PRESETS = {
  normal: { isArchive: 1, group: 'bunny-home' },
  time_sensitive: { level: 'timeSensitive', isArchive: 1, group: 'bunny-home' },
  alarm: { level: 'critical', volume: 5, call: 1, isArchive: 1, group: 'bunny-alarm' },
};

// 校验/规整 Bark icon：仅接受公网 http(s) 绝对地址，排除 data:/blob:/localhost/127.0.0.1。
// 头像 URL 可能自带 query（?token=…），整串作为单个 query 参数交给 URLSearchParams 编码。
export function toBarkIcon(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return '';
  try {
    const p = new URL(u);
    if (p.hostname === 'localhost' || p.hostname === '127.0.0.1' || p.hostname === '::1') return '';
  } catch {
    return '';
  }
  return u;
}

// 读取当前用户（单用户 owner）的助手头像公网 URL，作为 Bark 通知 icon。
// 失败 / 无头像时返回 ''（Bark 用默认图标），绝不抛出、绝不阻断通知。
export async function resolveAssistantIcon() {
  try {
    const user = await ensureOwner();
    const doc = await getState(user.id);
    return toBarkIcon(doc?.aiSettings?.assistantAvatarUrl);
  } catch (e) {
    return '';
  }
}

// 统一构造 Bark URL（标题/正文用 encodeURIComponent，参数用 URLSearchParams）
export function buildBarkUrl(barkUrl, opts = {}) {
  if (!barkUrl) return null;
  const { title = '', body = '', level = 'normal', sound, volume, call, group, isArchive, icon } = opts;
  const base = String(barkUrl).trim().replace(/\/+$/, '');
  const preset = LEVEL_PRESETS[level] || LEVEL_PRESETS.normal;
  const p = new URLSearchParams();
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); };
  // 预设值可被显式参数覆盖（sound 仅在显式传入时追加）
  set('level', preset.level);
  set('volume', volume !== undefined ? volume : preset.volume);
  set('call', call !== undefined ? call : preset.call);
  set('group', group !== undefined ? group : preset.group);
  set('isArchive', isArchive !== undefined ? isArchive : preset.isArchive);
  if (sound) set('sound', sound);
  set('icon', toBarkIcon(icon)); // 仅有效公网 URL 时追加 icon
  const qs = p.toString();
  return `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${qs ? '?' + qs : ''}`;
}

// 发送一条 Bark 通知（失败不阻断主流程，返回结果供调用方判断）。
// icon 由本服务自动解析当前助手头像；AI 只决定 title/body/type，不决定 icon。
export async function sendBark({ barkUrl, title, body, level, sound, volume, call, group, isArchive, icon }) {
  if (!barkUrl) return { sent: false, reason: 'no_bark_url' };
  const resolvedIcon = icon !== undefined ? toBarkIcon(icon) : await resolveAssistantIcon();
  const url = buildBarkUrl(barkUrl, { title, body, level, sound, volume, call, group, isArchive, icon: resolvedIcon });
  // 开发日志：只记级别与 icon 是否配置，绝不打印含 device token 的完整 Bark URL。
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[bark] 发送通知 type=${level || 'normal'} iconConfigured=${Boolean(resolvedIcon)}`);
  }
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      console.warn('[bark] 通知发送失败 HTTP', res.status);
      return { sent: false, reason: 'http_' + res.status };
    }
    return { sent: true };
  } catch (e) {
    console.warn('[bark] 通知发送异常：', e.message);
    return { sent: false, reason: 'error', error: e.message };
  }
}

// 兼容旧调用：普通通知（不携带任何强提醒参数）
export async function sendBarkNotification(barkUrl, title, body) {
  return sendBark({ barkUrl, title, body, level: 'normal' });
}
