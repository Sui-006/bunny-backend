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

// ============================================================
// AI 工具工作状态（与 public/index.html 内联 JS 保持一致）
// 核心原则：只展示可展示的「工作状态」，绝不把 raw tool name / result JSON / XML / 内部协议透出给用户。
// value 绝不硬编码助手名（助手名由调用方前置，AI 换名后自动更新）。
// ============================================================
export const AI_TOOL_STATUS_LABELS = {
  // AI 动态
  create_ai_activity: '正在写入动态……',
  get_ai_activities: '正在读取动态……',
  update_ai_activity: '正在更新动态……',
  delete_ai_activity: '正在删除动态……',
  set_ai_state: '正在调整心情……',
  // 记忆
  save_memory: '正在记录记忆……',
  update_memory: '正在更新记忆……',
  delete_memory: '正在整理记忆……',
  forget_memory: '正在整理记忆……',
  list_memories: '正在读取记忆……',
  get_memory_context: '正在读取记忆……',
  remember_user_preference: '正在记录偏好……',
  save_important_conversation: '正在记录重要对话……',
  // 任务
  create_task: '正在创建任务……',
  update_task: '正在更新任务……',
  complete_task: '正在完成任务……',
  delete_task: '正在删除任务……',
  list_tasks: '正在读取任务……',
  // 计划
  create_plan: '正在创建计划……',
  update_plan: '正在更新计划……',
  delete_plan: '正在删除计划……',
  add_plan_goal: '正在更新计划……',
  update_plan_goal: '正在更新计划……',
  list_plans: '正在读取计划……',
  // 日历
  create_calendar_event: '正在创建日历事件……',
  update_calendar_event: '正在更新日历……',
  delete_calendar_event: '正在删除日历……',
  get_calendar: '正在读取日历……',
  // 习惯
  create_habit: '正在创建习惯……',
  update_habit: '正在更新习惯……',
  complete_habit: '正在打卡习惯……',
  delete_habit: '正在删除习惯……',
  list_habits: '正在读取习惯……',
  // 购物
  add_shopping_item: '正在更新清单……',
  update_shopping_item: '正在更新清单……',
  complete_shopping_item: '正在更新清单……',
  delete_shopping_item: '正在更新清单……',
  list_shopping: '正在读取清单……',
  // 笔记
  create_note: '正在创建笔记……',
  update_note: '正在更新笔记……',
  delete_note: '正在删除笔记……',
  list_notes: '正在读取笔记……',
  // 财务（账单 + 最近购买）
  add_expense: '正在更新账单……',
  update_expense: '正在更新账单……',
  delete_expense: '正在更新账单……',
  get_expenses: '正在读取账单……',
  add_purchase: '正在更新清单……',
  update_purchase: '正在更新清单……',
  delete_purchase: '正在更新清单……',
  get_recent_purchases: '正在读取清单……',
  get_budget: '正在读取预算……',
  set_monthly_budget: '正在更新预算……',
  get_budget_summary: '正在读取预算……',
  // 健康 / 病历 / 经期
  add_health_record: '正在更新健康记录……',
  record_calories_in: '正在更新健康记录……',
  record_calories_out: '正在更新健康记录……',
  get_health_records: '正在读取健康记录……',
  add_medical_record: '正在更新健康记录……',
  update_medical_record: '正在更新健康记录……',
  delete_medical_record: '正在更新健康记录……',
  get_medical_records: '正在读取健康记录……',
  add_period_start: '正在更新健康记录……',
  add_period_end: '正在更新健康记录……',
  get_menstrual_cycles: '正在读取健康记录……',
  get_period_prediction: '正在读取健康记录……',
  // 音乐
  get_current_music: '正在读取音乐……',
  get_song_detail: '正在读取音乐……',
  get_song_comments: '正在读取音乐……',
  get_song_lyrics: '正在读取音乐……',
  get_recent_music: '正在读取音乐……',
  search_song: '正在搜索歌曲……',
  get_listening_context: '正在读取陪听……',
  start_listening_session: '正在更新陪听……',
  end_listening_session: '正在更新陪听……',
  recommend_next_song: '正在挑选下一首……',
  queue_song: '正在更新播放……',
  play_song: '正在更新播放……',
  pause_music: '正在更新播放……',
  resume_music: '正在更新播放……',
  skip_song: '正在更新播放……',
  like_song: '正在更新播放……',
  dislike_song: '正在更新播放……',
  // 日志 / 统计 / 会话历史
  get_journal: '正在读取日志……',
  get_statistics: '正在读取统计……',
  get_conversation_history: '正在读取历史……',
  // 对话缓存
  save_conversation_cache: '正在整理对话……',
  update_conversation_cache: '正在整理对话……',
  // 时间
  get_current_time: '正在确认时间……',
  // 通知
  send_bark_notification: '正在发送 Bark 通知……',
};

// 视为「成功完成」的工具 result code（其余 code 一律按失败/异常处理，绝不假装成功）。
export const TOOL_SUCCESS_CODES = new Set(['OK', 'CREATED', 'UPDATED', 'DELETED', 'SUCCESS', 'CANDIDATE', 'IGNORED', 'AUTO_SAVE_DISABLED']);

// 从工作文案提取「动作短语」：'正在发送 Bark 通知……' → '发送 Bark 通知'；未知工具 → '处理'。
export function toolStatusAction(name) {
  const label = AI_TOOL_STATUS_LABELS[name] || '正在处理……';
  return label.replace(/^正在/, '').replace(/……$/, '').trim();
}

// 工作状态文案（含助手名）。绝不把 raw tool name 直接透出。
export function toolWorkingText(name, assistantName) {
  const n = assistantName || 'Bunny';
  return n + (AI_TOOL_STATUS_LABELS[name] || '正在处理……');
}

// 工具结果 → 状态文案 + UI 状态（'done' | 'error'）。成功短暂显示「已…」，失败/拒绝/未配置/超时显示真实失败态。
export function toolResultStatus(name, code, assistantName) {
  const n = assistantName || 'Bunny';
  const action = toolStatusAction(name);
  if (code == null || TOOL_SUCCESS_CODES.has(code)) return { text: n + '已' + action, state: 'done' };
  // Bark 专用失败文案（与需求文档一致）
  if (name === 'send_bark_notification') {
    if (code === 'DENIED') return { text: n + '没有获得发送通知的权限', state: 'error' };
    if (code === 'NOT_CONFIGURED') return { text: n + '发现 Bark 还没有配置', state: 'error' };
    if (code === 'TIMEOUT') return { text: n + '发送通知超时', state: 'error' };
  }
  if (code === 'DENIED') return { text: n + '没有获得权限', state: 'error' };
  if (code === 'NOT_CONFIGURED') return { text: n + '发现还没有配置', state: 'error' };
  if (code === 'TIMEOUT') return { text: n + '操作超时', state: 'error' };
  if (code === 'NOT_FOUND') return { text: n + '没有找到相关内容', state: 'error' };
  return { text: n + action + '失败', state: 'error' };
}
