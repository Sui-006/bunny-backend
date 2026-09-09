import { randomUUID } from 'node:crypto';
import { getUserState, saveUserState } from './store.js';

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
    family: [], workspace: [], conversations: [], notifications: [],
    aiSettings: { aiName: 'Bunny', assistantAvatar: '', bubbleOpacity: 0.9, model: 'deepseek-chat', systemPrompt: '', streaming: true, memory: true, autoCompress: true },
    notifSettings: { morning: true, morningTime: '08:00', noon: false, noonTime: '12:00', night: true, nightTime: '22:00', idle: false, idleHours: 6, replyNotify: true },
    player: { playlist: [], current: 0, playing: false, currentTime: 0, volume: 0.8 },
    alarms: [],
  };
}

const ARR_KEYS = ['tasks', 'plans', 'habits', 'health', 'notes', 'family', 'workspace', 'conversations', 'notifications', 'alarms'];

// 修复/合并文档：补齐缺失键 + 保证每种计划类型至少一个（业务规则，服务端兜底）
export function repairState(s) {
  const def = defaultState();
  const out = { ...def, ...(s && typeof s === 'object' ? s : {}) };
  for (const k of Object.keys(def)) if (out[k] == null) out[k] = def[k];
  for (const k of ARR_KEYS) if (!Array.isArray(out[k])) out[k] = [];
  for (const t of PLAN_TYPES) if (!out.plans.some((p) => p.type === t)) out.plans.push(defaultPlan(t));
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
async function withDoc(userId, fn) {
  const doc = await getState(userId);
  const result = fn(doc);
  await saveUserState(userId, doc);
  return result;
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

// 计划整体进度（用于统计）
export function planProgress(plan) {
  const goals = plan.stageGoals || [];
  if (goals.length === 0) return 0;
  const sum = goals.reduce((acc, g) => acc + (Number(g.progress) || 0), 0);
  return Math.round(sum / goals.length);
}
