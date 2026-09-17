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

// 登录态变化判定：决定是否需要整页 render（只在登录态真正变化时，避免 Music 页持续刷新）。
// prevUserId: 当前缓存的 userId（null=未登录）。result: /api/music/status 的响应。
// 返回 { action, needRender, user? }。
export function neteaseStatusDelta(prevUserId, result) {
  const s = neteaseUiState(result, prevUserId);
  switch (s.action) {
    case 'networkError': return { action: 'networkError', needRender: false };
    case 'error': return { action: 'error', needRender: false };
    case 'expired': return { action: 'expired', needRender: true };
    case 'notLoggedIn': return { action: 'notLoggedIn', needRender: prevUserId != null };
    case 'loggedIn': return { action: 'loggedIn', needRender: prevUserId !== s.user.userId, user: s.user };
    default: return { action: s.action, needRender: false };
  }
}

// 高频音乐事件渲染策略（与 public/index.html 内联 JS 保持一致）：
// 只有「用户主动切歌 / 登录态变化 / 队列结构变化」这类低频动作才允许整页 render；
// timeupdate / play / pause / progress / volumechange / playerTick 等高频状态一律走局部 DOM 更新，绝不能触发整页重建。
// 返回 true 表示该事件类型允许整页 render（否则必须局部更新）。
export function musicEventNeedsRender(eventType) {
  const RENDERABLE = new Set([
    'play-track',       // 用户主动切歌 / 自动接歌：标题/封面/歌手全变，允许一次整页 render
    'track-change',     // 同上（别名）
    'queue-replace',    // 播放/切换歌单：替换队列
    'add-to-queue',     // 加入队列：队列结构变化
    'login-change',     // 网易云登录态变化（首次登录/换号）
    'login-expired',    // 登录失效
    'logout',           // 主动退出
    'toggle-together',  // 一起听开关
  ]);
  return RENDERABLE.has(eventType);
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

// 全局字体大小档位 → CSS zoom 缩放值（与 public/index.html 的 FONT_SCALES 保持一致）。
export function fontScaleValue(key) {
  const SCALES = { small: 0.875, standard: 1, large: 1.125, xlarge: 1.25 };
  return SCALES[key] || SCALES.standard || 1;
}

// Token 归一化：仅接受有限且 ≥0 的数字，否则 null（绝不估算 text.length / /4）。
export function chatTokenNumber(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 从消息 metadata 提取真实 output/input token 数：优先归一化后的 contextStats，回退原始 usage 字段。
export function chatOutputTokens(msg) {
  const md = (msg && msg.metadata && typeof msg.metadata === 'object') ? msg.metadata : {};
  const usage = md.usage || {};
  const cs = md.contextStats || {};
  return chatTokenNumber(cs.outputTokens != null ? cs.outputTokens : usage.output_tokens);
}

// Token 行文案：仅 AI（assistant）且存在真实 outputTokens 时才返回「128 tokens」；用户/缺失一律 ''。
export function chatTokenText(msg) {
  if (!msg || msg.role !== 'assistant') return '';
  const out = chatOutputTokens(msg);
  return out == null ? '' : out + ' tokens';
}

// 思考摘要：仅展示 provider 明确给出的 reasoning_content（AI 角色且非空）；否则不展示、绝不伪造。
export function chatReasoning(msg) {
  if (!msg || msg.role !== 'assistant') return '';
  return msg.reasoning_content || '';
}

// 聊天响应解析方式：只依据 HTTP status + Content-Type 判定，绝不依据 aiSettings.streaming（与 public/index.html 内联 JS 保持一致）。
// 后端「流式/非流式」由 session.settings.stream 决定；前端必须按实际响应头选解析器，
// 否则二者不同步时会把正常 JSON 回复误报成「AI 流式响应异常」。
// 返回 { mode, isJson }：
//   sse   → text/event-stream + 2xx：走 SSE 流式解析（后端流内错误经 data:{error} 传递，HTTP 仍是 200）
//   json  → application/json + 2xx：走 JSON 非流式解析（正常回复）
//   error → 4xx/5xx 的 JSON、或未知 content-type：解析真实错误并抛出
export function classifyChatResponse(status, contentType) {
  const ct = (contentType || '').toLowerCase();
  const ok = status >= 200 && status < 300;
  if (ct.includes('text/event-stream')) return ok ? { mode: 'sse', isJson: false } : { mode: 'error', isJson: true };
  if (ct.includes('application/json')) return ok ? { mode: 'json', isJson: true } : { mode: 'error', isJson: true };
  return { mode: 'error', isJson: false };
}
