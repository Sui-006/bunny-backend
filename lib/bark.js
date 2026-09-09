// Bark 推送服务：统一构造 URL + 发送。
// 通知级别 → Bark 参数（关键：普通通知绝不使用 critical/volume/call）：
//   normal          → isArchive=1&group=bunny-home
//   time_sensitive  → level=timeSensitive&isArchive=1&group=bunny-home
//   alarm（强提醒） → level=critical&volume=5&call=1&isArchive=1&group=bunny-alarm
//
// 只有用户明确「设闹钟 / 强提醒」时才允许 level=critical / volume=5 / call=1。

const LEVEL_PRESETS = {
  normal: { isArchive: 1, group: 'bunny-home' },
  time_sensitive: { level: 'timeSensitive', isArchive: 1, group: 'bunny-home' },
  alarm: { level: 'critical', volume: 5, call: 1, isArchive: 1, group: 'bunny-alarm' },
};

// 统一构造 Bark URL（标题/正文用 encodeURIComponent，参数用 URLSearchParams）
export function buildBarkUrl(barkUrl, opts = {}) {
  if (!barkUrl) return null;
  const { title = '', body = '', level = 'normal', sound, volume, call, group, isArchive } = opts;
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
  const qs = p.toString();
  return `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${qs ? '?' + qs : ''}`;
}

// 发送一条 Bark 通知（失败不阻断主流程，返回结果供调用方判断）
export async function sendBark({ barkUrl, title, body, level, sound, volume, call, group, isArchive }) {
  const url = buildBarkUrl(barkUrl, { title, body, level, sound, volume, call, group, isArchive });
  if (!url) return { sent: false, reason: 'no_bark_url' };
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      console.warn('[bark] 通知发送失败 HTTP', res.status);
      return { sent: false, reason: 'http_' + res.status, url };
    }
    return { sent: true, url };
  } catch (e) {
    console.warn('[bark] 通知发送异常：', e.message);
    return { sent: false, reason: 'error', error: e.message, url };
  }
}

// 兼容旧调用：普通通知（不携带任何强提醒参数）
export async function sendBarkNotification(barkUrl, title, body) {
  return sendBark({ barkUrl, title, body, level: 'normal' });
}
