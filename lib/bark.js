// Bark 推送：GET {bark_url}/{title}/{body}（失败不阻断主流程）
export async function sendBarkNotification(barkUrl, title, body) {
  if (!barkUrl) return;
  const base = String(barkUrl).trim().replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) console.warn('[bark] 通知发送失败 HTTP', res.status);
  } catch (e) {
    console.warn('[bark] 通知发送异常：', e.message);
  }
}
