import { randomUUID } from 'node:crypto';
import { getUserState, saveUserState, saveUserStateIfVersion } from './store.js';

// 生活数据文档（前端 DB）的访问层 + 业务规则。
// 后端把整份文档存 PostgreSQL 的 users.user_state（jsonb），细粒度 REST 读写同一份文档。

export const PLAN_TYPES = ['long-term', 'stage', 'monthly', 'weekly'];

const TYPE_META = {
  'long-term': { def: '我的长期计划', color: '#6b8cae' },
  stage:       { def: '第一阶段', color: '#8b5cf6' },
  monthly:     { def: null, color: '#10b981' },
  weekly:      { def: null, color: '#f97316' },
};

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dstr(new Date());
function parseDate(s) { const p = String(s || '').split('-').map(Number); if (p.length !== 3 || p.some(isNaN)) return null; return new Date(p[0], p[1] - 1, p[2]); }
function addDays(s, n) { const d = parseDate(s) || new Date(); d.setDate(d.getDate() + n); return dstr(d); }
function startOfWeek(s) { const d = parseDate(s) || new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dstr(d); }
const monthTitle = (y, m) => `${y}年${m + 1}月`;
const ymd = (s) => String(s || '').split('-').join('.');
const weekTitle = (s) => { const w = startOfWeek(s); return `${ymd(w)} — ${ymd(addDays(w, 6))}`; };

export function defaultPlan(type) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const ws = startOfWeek(todayStr());
  const meta = TYPE_META[type];
  let title, startDate, endDate;
  if (type === 'long-term') { title = meta.def; startDate = todayStr(); endDate = ''; }
  else if (type === 'stage') { title = meta.def; startDate = todayStr(); endDate = ''; }
  else if (type === 'monthly') { title = monthTitle(now.getFullYear(), now.getMonth()); startDate = `${thisMonth}-01`; endDate = `${thisMonth}-28`; }
  else { title = weekTitle(todayStr()); startDate = ws; endDate = addDays(ws, 6); }
  return { id: randomUUID(), type, title, description: '', startDate, endDate, themeColor: meta.color, parentPlanId: null, archived: false, createdAt: Date.now(), updatedAt: Date.now(), longGoal: '', stageGoals: [], results: [] };
}

export function defaultState() {
  const longTerm = defaultPlan('long-term');
  const stage = defaultPlan('stage');
  stage.parentPlanId = longTerm.id;
  return {
    version: 1,
    appName: "Bunny's Home",
    profile: { name: '', signature: '', avatar: '' },
    appearance: { theme: 'light', accent: '#6b8cae', font: '', wallpaper: '' },
    tasks: [], plans: [longTerm, stage], habits: [], health: [], notes: [],
    // 日志（用户亲笔，AI 只读，绝不改）与购物清单/条目（AI 可编辑）
    journal: [], shoppingLists: [], shoppingItems: [],
    // 健康档案：身高为单一值（cm），体重/饮水/睡眠/热量按天记录在 health[] 中
    healthProfile: { height: null },
    notifications: [],
    aiSettings: { aiName: 'Bunny', assistantAvatar: '', assistantAvatarUrl: '', bubbleOpacity: 0.9, model: 'deepseek-chat', systemPrompt: '', streaming: true, memory: true, autoCompress: true },
    // AI 助手（与「模型」解耦）：每个助手绑定 id/name/avatar/personality/systemPrompt/model
    assistants: [{ id: 'bunny', name: 'Bunny', avatar: '', avatarUrl: '', personality: '温柔、体贴、简洁的 AI 伴侣', systemPrompt: '', model: 'deepseek-chat', createdAt: Date.now() }],
    activeAssistantId: 'bunny',
    notifSettings: { morning: true, morningTime: '08:00', noon: false, noonTime: '12:00', night: true, nightTime: '22:00', idle: false, idleHours: 6, replyNotify: true },
    player: { playlist: [], current: 0, playing: false, currentTime: 0, volume: 0.8 },
    // 「一起听」陪听会话（单用户一次一个；绑定 assistantId，绝不 assistants[0]）
    listeningSession: null,
    // 音乐品味画像：只有明确喜欢/不喜欢才更新，播放一次/跳过不算
    musicTasteProfile: { favoriteArtists: [], favoriteGenres: [], favoriteSongs: [], dislikedArtists: [], dislikedSongs: [], likedPatterns: [], dislikedPatterns: [], moodPreferences: [], discoveryHistory: [], updatedAt: 0 },
    // 收听历史（最近播放 + like/dislike/skip 记录，供推荐与画像）
    listeningHistory: [],
    // 用户长期记忆（结构化，存 user_state 文档；后端 memory-service 读写，前端 /ai/memory 管理）
    // 前端历史里放在 DB.ai.memories，这里提供稳定默认；条目形状由 memory-service normalizeMemory 统一。
    // memoryCandidates=待确认候选（status=pending，不注入上下文）；memorySignals=偏好信号计数（balanced 重复检测）。
    ai: { memories: [], memoryCandidates: [], memorySignals: [], auditLog: [], activities: [], states: [], styleProfile: {}, styleSignals: [] },
    // 记忆设置：enabled=是否启用记忆读取；autoSaveEnabled=是否允许 AI 自动保存；confirmationMode=保存确认模式
    memorySettings: { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' },
    alarms: [],
    // 财务（金额一律存整数分 amountCents，避免浮点误差）
    purchases: [],
    expenses: [],
    budget: { monthlyCents: null, currency: 'CNY' },
    // 健康隐私（经期 / 个人病历）
    menstrualCycles: [],
    medicalRecords: [],
  };
}

const ARR_KEYS = ['tasks', 'plans', 'habits', 'health', 'notes', 'journal', 'shoppingLists', 'shoppingItems', 'notifications', 'alarms', 'purchases', 'expenses', 'menstrualCycles', 'medicalRecords'];

// 修复/合并文档：补齐缺失键 + 保证每种计划类型至少一个（业务规则，服务端兜底）
export function repairState(s) {
  const def = defaultState();
  const out = { ...def, ...(s && typeof s === 'object' ? s : {}) };
  for (const k of Object.keys(def)) if (out[k] == null) out[k] = def[k];
  for (const k of ARR_KEYS) if (!Array.isArray(out[k])) out[k] = [];
  // AI 助手：数据库里没有默认 Bunny 时自动补一个（需求：助手数据必须真实存在）
  if (!Array.isArray(out.assistants) || out.assistants.length === 0) out.assistants = def.assistants;
  if (!out.assistants.some((a) => a.id === out.activeAssistantId)) out.activeAssistantId = out.assistants[0].id;
  for (const t of PLAN_TYPES) if (!out.plans.some((p) => p.type === t)) out.plans.push(defaultPlan(t));
  // 陪听会话 / 品味画像 / 收听历史：保证结构存在（内容为 null / 空，绝不伪造）
  if (out.listeningSession != null && typeof out.listeningSession !== 'object') out.listeningSession = null;
  if (!out.musicTasteProfile || typeof out.musicTasteProfile !== 'object') out.musicTasteProfile = def.musicTasteProfile;
  if (!Array.isArray(out.listeningHistory)) out.listeningHistory = [];
  if (!out.player) out.player = def.player;
  if (out.player.togetherListening == null) out.player.togetherListening = false;
  if (out.player.autoNext == null) out.player.autoNext = false;
  // 长期记忆：确保 ai.memories 是数组（老前端可能把记忆放在 ai.memories，保持兼容）
  if (!out.ai || typeof out.ai !== 'object') out.ai = { memories: [], memoryCandidates: [], memorySignals: [] };
  if (!Array.isArray(out.ai.memories)) out.ai.memories = [];
  // 对话风格画像（user-level，跨窗口继承）：保证对象存在；绝不与 memories/cache 混在同一结构
  if (!out.ai.styleProfile || typeof out.ai.styleProfile !== 'object' || Array.isArray(out.ai.styleProfile)) out.ai.styleProfile = {};
  // 风格偏好信号计数（重复检测，仅计数，不进上下文）
  if (!Array.isArray(out.ai.styleSignals)) out.ai.styleSignals = [];
  // 候选记忆（待确认，绝不与正式记忆混在同一数组）
  if (!Array.isArray(out.ai.memoryCandidates)) out.ai.memoryCandidates = [];
  // 偏好信号计数（balanced 模式的重复检测，仅计数，不进上下文）
  if (!Array.isArray(out.ai.memorySignals)) out.ai.memorySignals = [];
  // AI 编辑审计日志（before/after/actor/原因/会话）
  if (!Array.isArray(out.ai.auditLog)) out.ai.auditLog = [];
  // AI 动态（AI 自己的活动流水）：保证数组存在，供 create_ai_activity 落库
  if (!Array.isArray(out.ai.activities)) out.ai.activities = [];
  // AI 心情状态（情绪 + 强度 + 原因）：保证数组存在，供「今天的祂」/ 统一上下文读取
  if (!Array.isArray(out.ai.states)) out.ai.states = [];
  // 记忆设置：补齐缺省字段
  const ms = out.memorySettings && typeof out.memorySettings === 'object' ? out.memorySettings : {};
  out.memorySettings = {
    enabled: ms.enabled !== false,
    autoSaveEnabled: ms.autoSaveEnabled !== false,
    confirmationMode: ['explicit_only', 'ask_before_save', 'balanced'].includes(ms.confirmationMode) ? ms.confirmationMode : 'ask_before_save',
  };
  return out;
}

export async function getState(userId) {
  const raw = await getUserState(userId);
  return repairState(raw ?? {});
}

export async function putState(userId, doc) {
  const repaired = repairState(doc);
  await saveUserState(userId, repaired);
  return repaired;
}

// ---- 通用集合操作（读改写同一份文档） ----

// 版本冲突错误（乐观并发）：不带 HttpError 类，避免 rest.js ↔ domain.js 循环依赖；
// 由 server.js 的统一错误处理识别 status+code，输出结构化 JSON。
function versionConflict() {
  const e = new Error('数据已被其他操作修改，请重试');
  e.status = 409;
  e.code = 'VERSION_CONFLICT';
  return e;
}

// 带乐观并发控制的读改写：读当前版本 → 执行 fn（只改目标路径）→ 版本 +1 后 CAS 写回。
// 若版本被并发修改（CAS 失败），重新读最新文档并重试；超过重试次数抛出 409。
// fn 必须是纯文档变换（只改 doc，不产生文档外副作用），这样重试是安全的。
export async function withDocVersioned(userId, fn, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const doc = await getState(userId);
    const baseVersion = Number(doc.version) || 1;
    const result = fn(doc);
    doc.version = baseVersion + 1;
    if (await saveUserStateIfVersion(userId, doc, baseVersion)) return { result, version: doc.version };
  }
  throw versionConflict();
}

// 便捷封装：只关心 fn 的返回值（通用 CRUD 用），不关心版本号。
export async function withDoc(userId, fn, opts) {
  return (await withDocVersioned(userId, fn, opts)).result;
}

export async function listColl(userId, key) {
  const doc = await getState(userId);
  return doc[key] || [];
}

export async function getOne(userId, key, id) {
  const doc = await getState(userId);
  return (doc[key] || []).find((x) => x.id === id) ?? null;
}

export async function insertOne(userId, key, item) {
  return withDoc(userId, (doc) => {
    const full = { id: randomUUID(), createdAt: Date.now(), ...item };
    doc[key].push(full);
    return full;
  });
}

export async function patchOne(userId, key, id, patch) {
  return withDoc(userId, (doc) => {
    const arr = doc[key] || [];
    const item = arr.find((x) => x.id === id);
    if (!item) throw new Error('记录不存在');
    Object.assign(item, patch, { updatedAt: Date.now() });
    return item;
  });
}

export async function removeOne(userId, key, id) {
  return withDoc(userId, (doc) => {
    const before = (doc[key] || []).length;
    doc[key] = (doc[key] || []).filter((x) => x.id !== id);
    return (doc[key] || []).length < before;
  });
}

// ---- 习惯连续天数（由 completions 计算，与前端一致） ----
export function habitStreak(completions) {
  const set = new Set(completions || []);
  let streak = 0;
  let d = todayStr();
  if (!set.has(d)) d = addDays(d, -1);
  while (set.has(d)) { streak++; d = addDays(d, -1); }
  return streak;
}

// 累计完成次数：只统计「已跨 0 点」的日期（严格早于今天）。
// 今天的打卡由 currentStreak / 今日状态体现，未进入累计；这样重复刷新/重复请求都不会 +1。
export function habitTotalCompletions(completions, today = todayStr()) {
  const set = new Set(completions || []);
  let n = 0;
  for (const d of set) if (d && d < today) n++;
  return n;
}

// 一次性返回累计次数 + 连续天数（两个独立概念，不混为一个字段）
export function habitStats(completions, today = todayStr()) {
  return { totalCompletions: habitTotalCompletions(completions, today), currentStreak: habitStreak(completions) };
}

// ---- 任务 → 计划层级链 ----
export function planChain(doc, planId) {
  const byId = new Map(doc.plans.map((p) => [p.id, p]));
  const chain = { longTermPlanId: null, stagePlanId: null, monthlyPlanId: null, weeklyPlanId: null };
  let cur = byId.get(planId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === 'long-term') chain.longTermPlanId = cur.id;
    else if (cur.type === 'stage') chain.stagePlanId = cur.id;
    else if (cur.type === 'monthly') chain.monthlyPlanId = cur.id;
    else if (cur.type === 'weekly') chain.weeklyPlanId = cur.id;
    cur = byId.get(cur.parentPlanId);
  }
  return chain;
}

// ---- AI 动态（AI 自己的活动流水） ----
// 只有「AI 自己写下的动态」才算 AI Activity：actor=assistant 且 entityType=activity。
// 系统日志（actor=system）、用户内容（actor=user）、其他 entityType（journal/task/sync/…）一律不算，
// 绝不靠文字判断、也不把系统/用户条目冒充成 AI 动态。
export function isAiActivity(a) {
  return !!a && typeof a === 'object' && (a.entityType === 'activity' || a.actor === 'assistant');
}

// 取「AI 动态」子集（过滤掉系统/用户/其他实体条目），按时间倒序（activities 本身是 unshift 的最新在前）。
export function aiActivities(doc) {
  const acts = (doc && doc.ai && Array.isArray(doc.ai.activities)) ? doc.ai.activities : [];
  return acts.filter(isAiActivity);
}

// 追加一条 AI 动态（结构化 actor/entityType/source；type 为动态分类，缺省 chat）。
// 纯文档变换（只改 doc.ai.activities），供工具与主动消息共用，绝不直接碰存储。
export function appendAiActivity(doc, { type = 'chat', text = '', source = 'assistant', reason = '' }) {
  if (!doc.ai || typeof doc.ai !== 'object') doc.ai = {};
  if (!Array.isArray(doc.ai.activities)) doc.ai.activities = [];
  const activity = {
    id: randomUUID(), type, text: String(text || '').trim(), time: Date.now(),
    actor: 'assistant', entityType: 'activity', source,
  };
  if (reason) activity.reason = reason;
  doc.ai.activities.unshift(activity);
  return activity;
}

// 计划整体进度（用于统计）
export function planProgress(plan) {
  const goals = plan.stageGoals || [];
  if (goals.length === 0) return 0;
  const sum = goals.reduce((acc, g) => acc + (Number(g.progress) || 0), 0);
  return Math.round(sum / goals.length);
}
