// 前端纯逻辑（与 public/index.html 内联 JS 保持一致，供 node --test 单测复用）。
// 这里的函数都是无 DOM、无副作用的纯函数；前端内联版本与之保持同步。

// 网易云登录状态机：根据 /api/music/status 结果 + 上次 userId，决定 UI 状态。
// 返回 { action, user?, changed? }；action ∈ loggedIn | notLoggedIn | expired | error | networkError。
export function neteaseUiState(result, prevUserId) {
  if (!result || result.ok === false) return { action: 'networkError' };
  const st = result.data || {};
  if (st.status === 'expired') return { action: 'expired' };
  if (st.status === 'error') return { action: 'error' };
  // 权威来源是后端 /api/music/status：兼容「status='logged_in'」与旧后端只回 userId 的形状
  // （旧后端 loginStatus() 返回 {userId,nickname,avatarUrl} 或 null，无 status 字段）。
  const userId = (st.userId != null && st.userId !== '') ? st.userId : null;
  if (st.status !== 'logged_in' && userId == null) return { action: 'notLoggedIn' };
  const user = { userId: st.userId, nickname: st.nickname, avatarUrl: st.avatarUrl };
  return { action: 'loggedIn', user, changed: prevUserId !== st.userId };
}

// 记忆加载防重入 + 循环守卫：返回下一状态标志。
// loading=true 时忽略重复调用（防重入）；成功 → loaded=true；失败 → error 置位、loaded 保持 false（不再自动重拉）。
export function memoryLoadFlags(prev, result) {
  if (prev.loading) return prev;
  if (result.ok) return { loading: false, loaded: true, error: null };
  return { loading: false, loaded: false, error: result.error || '加载失败' };
}

// 壁纸压缩：按最长边计算目标尺寸（不放大，向上取整到 ≥1）。
export function targetWallpaperSize(w, h, maxDim = 1600) {
  if (!w || !h) return { width: w, height: h, scaled: false };
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { width: w, height: h, scaled: false };
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scaled: true };
}

// 壁纸编码格式：WebP data URL 有效则用 WebP，否则回退 JPEG（老 Safari 不支持 WebP 时 toDataURL 会回退成 PNG，需检测前缀）。
export function pickWallpaperMime(webpDataUrl) {
  return (webpDataUrl && webpDataUrl.startsWith('data:image/webp')) ? 'image/webp' : 'image/jpeg';
}

// 附件大小上限（与前端 onFiles 一致：图片 ≤20MB，文件 ≤50MB）。
export function attachmentMaxSize(isImg) {
  return isImg ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
}

// 附件校验：返回 { ok, isImg, max, error? }。
export function validateAttachmentFile(size, type) {
  const isImg = (type || '').startsWith('image/');
  const max = attachmentMaxSize(isImg);
  if (size > max) return { ok: false, isImg, max, error: '文件过大（' + (isImg ? '图片≤20MB' : '文件≤50MB') + '）' };
  return { ok: true, isImg, max };
}

// 附件 id 去重 + 上限 10（与后端 resolveAttachments 一致）。
export function dedupeAttachmentIds(ids) {
  const seen = new Set(); const out = [];
  for (const id of (ids || [])) {
    if (id == null) continue;
    const s = String(id).trim();
    if (!s) continue;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.slice(0, 10);
}
