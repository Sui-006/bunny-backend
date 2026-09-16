// 轻量级用户长期记忆服务（Memory Service）。
// 目标：结构化记忆 + 重要对话摘要 + 配置读取 + 用户可控 + 安全隔离。
// 关键约束：
//   - 不引入向量数据库 / Embedding / 复杂语义搜索：相关性用确定性关键词打分。
//   - 数据存 users.user_state 文档的 doc.ai.memories（PostgreSQL jsonb，单一事实来源，非 localStorage）。
//   - 所有记忆严格按 userId 隔离（由调用方 getState/putState 的 owner 文档保证）。
//   - 记忆必须区分用户级（assistantId=null，所有助手可读）与助手级（绑定当前 activeAssistantId，绝不 assistants[0]）。
//   - 克制写入：默认不记寒暄/一次性情绪/临时计划；只有明确指令或稳定偏好才进入候选。
//   - 敏感信息（密码/密钥/身份证/银行卡/cookie/token/精确位置）拒绝保存原文。
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/rest.js';

// 分类枚举（section 三）
export const MEMORY_CATEGORIES = ['profile', 'preference', 'important_conversation', 'functional_preference', 'task_context'];
export const CATEGORY_LABELS = {
  profile: '我的信息',
  preference: '我的偏好',
  important_conversation: '重要对话',
  functional_preference: '功能配置',
  task_context: '项目上下文',
};
export const SOURCES = ['user_explicit', 'user_message', 'ai_extracted', 'imported', 'system_config'];
export const IMPORTANCE_LEVELS = ['low', 'normal', 'high', 'critical'];
export const CONFIRMATION_MODES = ['explicit_only', 'ask_before_save', 'balanced'];

// 大小 / 数量限制（section 九 / 十三）
export const LIMITS = {
  maxSummary: 2000,      // summary 字符上限
  maxTitle: 200,
  maxKey: 200,
  maxValueChars: 8000,   // value JSON 序列化后上限（超过则拒绝）
  injectCount: 10,       // 每次注入最多记忆条数
  injectChars: 4000,     // 每次注入记忆总字符预算
  maxMemories: 500,      // 单用户记忆总量上限（防无限增长）
};

// 候选记忆限制（section 七）：待确认候选独立于正式记忆，有数量上限 + 过期时间，绝不无限累积
export const CANDIDATE_LIMITS = {
  maxPending: 20,                    // 最多同时保留的待确认候选
  expiryMs: 7 * 24 * 3600 * 1000,    // 候选过期时间（7 天）
};

// 敏感信息模式（section 十三：默认不保存密码/API key/Bark/身份证/银行卡/cookie/token/精确位置）
const SENSITIVE_PATTERNS = [
  ['password', /(password|passwd|密码|口令|登录密码)/i],
  ['api_key', /(api[_-]?key|secret[_-]?key|access[\s_-]?token|refresh[\s_-]?token|访问令牌|密钥|令牌|sk-[a-z0-9]{6,})/i],
  ['authorization', /(authorization|bearer)/i],
  ['cookie', /(cookie|session[_-]?id|登录态)/i],
  ['id_card', /(身份证|身份证号|\b\d{17}[\dXx]\b)/],
  ['bank', /(银行卡|信用卡|卡号|\b\d{16,19}\b)/],
  ['bark', /(bark|device[_-]?token|推送\s?token)/i],
  ['precise_location', /(精确位置|经纬度|lat[=:]\s*-?\d+\.\d+|lng[=:]\s*-?\d+\.\d+)/i],
];

export function defaultMemorySettings() {
  return { enabled: true, autoSaveEnabled: true, confirmationMode: 'ask_before_save' };
}

export function memorySettings(doc) {
  const s = (doc && doc.memorySettings && typeof doc.memorySettings === 'object') ? doc.memorySettings : {};
  return {
    enabled: s.enabled !== false,
    autoSaveEnabled: s.autoSaveEnabled !== false,
    confirmationMode: CONFIRMATION_MODES.includes(s.confirmationMode) ? s.confirmationMode : 'ask_before_save',
  };
}

export function isEnabled(doc) {
  return memorySettings(doc).enabled;
}

export function autoSaveEnabled(doc) {
  return memorySettings(doc).autoSaveEnabled;
}

// 当前激活助手 id（绝不 assistants[0]）
export function activeAssistantId(doc) {
  return (doc && doc.activeAssistantId) || null;
}

// 分类归一化：把老自由文本分类 / 未知值映射到枚举
export function normalizeCategory(v) {
  const s = String(v || '').trim();
  if (MEMORY_CATEGORIES.includes(s)) return s;
  if (/偏好|喜欢|喜好|习惯|prefer|taste/i.test(s)) return 'preference';
  if (/重要|记住|决策|约定|项目|决定|conversation|important/i.test(s)) return 'important_conversation';
  if (/信息|profile|称呼|名字|语言|昵称/i.test(s)) return 'profile';
  if (/配置|功能|设置|functional|config/i.test(s)) return 'functional_preference';
  if (/上下文|约束|任务|task|context/i.test(s)) return 'task_context';
  return 'preference';
}

const validEnum = (v, list) => list.includes(v) ? v : null;

function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.8;
}

// 把旧版（仅 content/category/confidence）或任意形状条目规整为结构化记忆。
// 纯函数；写回时统一用此形状，读时也统一，避免双形状并存。
export function normalizeMemory(m) {
  if (!m || typeof m !== 'object') return null;
  const summary = String(m.summary || m.content || '').trim();
  const sourceType = String(m.sourceType || '');
  return {
    id: m.id || randomUUID(),
    category: normalizeCategory(m.category),
    key: String(m.key || '').slice(0, LIMITS.maxKey),
    value: m.value !== undefined ? m.value : null,
    summary,
    content: summary, // 兼容老前端读取 m.content
    title: String(m.title || '').slice(0, LIMITS.maxTitle),
    source: validEnum(m.source, SOURCES) || (sourceType === 'manual' || sourceType === 'import' || sourceType === 'imported' ? 'imported' : 'user_message'),
    sourceType,
    sourceId: m.sourceId ?? null,
    sourceMessageId: m.sourceMessageId ?? null,
    sourceConversationId: m.sourceConversationId ?? null,
    importance: validEnum(m.importance, IMPORTANCE_LEVELS) || 'normal',
    confidence: clamp01(m.confidence ?? 0.8),
    isActive: m.isActive !== false,
    userConfirmed: m.userConfirmed === true,
    createdAt: m.createdAt || Date.now(),
    updatedAt: m.updatedAt || m.createdAt || Date.now(),
    expiresAt: m.expiresAt ?? null,
    lastUsedAt: m.lastUsedAt ?? null,
    assistantId: m.assistantId ?? null, // null=用户级；否则为某助手 id
  };
}

export function getMemories(doc) {
  const arr = (doc && doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  return arr.map(normalizeMemory).filter(Boolean);
}

// 仅「有效」记忆：isActive 且未过期
export function activeMemories(doc) {
  const now = Date.now();
  return getMemories(doc).filter((m) => m.isActive && (!m.expiresAt || m.expiresAt > now));
}

// 过滤助手作用域：用户级(null) + 当前激活助手；排除绑到其他助手的记录
function scoped(memories, doc) {
  const active = activeAssistantId(doc);
  return memories.filter((m) => m.assistantId == null || m.assistantId === active);
}

// 敏感信息检测：返回命中的类型名，否则 null
export function detectSensitive(text) {
  const s = String(text || '');
  for (const [type, re] of SENSITIVE_PATTERNS) {
    if (re.test(s)) return type;
  }
  return null;
}

export function isSensitive(value) {
  return detectSensitive(value) !== null;
}

// 字段校验 + 长度限制（section 十三）。value 超限 → 拒绝；summary/key/title 超长 → 截断。
function enforceLimits(fields) {
  if (fields.value !== undefined && fields.value !== null) {
    let serialized;
    try { serialized = JSON.stringify(fields.value); } catch { serialized = String(fields.value); }
    if (serialized && serialized.length > LIMITS.maxValueChars) {
      throw new HttpError(422, 'VALUE_TOO_LARGE', `记忆 value 过大（超过 ${LIMITS.maxValueChars} 字符）`);
    }
  }
  for (const k of ['summary', 'content']) {
    if (fields[k] != null) fields[k] = String(fields[k]).slice(0, LIMITS.maxSummary);
  }
  if (fields.key != null) fields.key = String(fields.key).slice(0, LIMITS.maxKey);
  if (fields.title != null) fields.title = String(fields.title).slice(0, LIMITS.maxTitle);
  return fields;
}

// 助手 id 消毒：只允许绑定当前激活助手（或 null=用户级），绝不接受 assistants[0] 之外的任意值
function sanitizeAssistantId(doc, v) {
  if (v == null || v === '') return null;
  const active = activeAssistantId(doc);
  return v === active ? active : null;
}

// ---------------- 创建 / 更新 ----------------

export function createMemory(doc, fields = {}) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : ((doc.ai = doc.ai || {}).memories = []);
  if (arr.length >= LIMITS.maxMemories) {
    throw new HttpError(422, 'MEMORY_LIMIT', `记忆数量已达上限（${LIMITS.maxMemories} 条）`);
  }
  let summary = String(fields.summary || fields.content || '').trim();
  if (!summary) throw new HttpError(400, 'INVALID', '记忆内容不能为空');
  const sensitive = detectSensitive(summary + ' ' + JSON.stringify(fields.value ?? ''));
  if (sensitive) {
    throw new HttpError(422, 'SENSITIVE_CONTENT', `检测到敏感信息（${sensitive}），记忆系统不会保存密码/密钥/证件/银行卡等原文，请改用专门的安全存储`);
  }
  enforceLimits(fields);
  summary = String(fields.summary || fields.content || '').trim(); // 截断后重取
  const category = normalizeCategory(fields.category);
  const now = Date.now();
  const mem = {
    id: fields.id || randomUUID(),
    category,
    key: String(fields.key || '').slice(0, LIMITS.maxKey),
    value: fields.value !== undefined ? fields.value : null,
    summary,
    content: summary,
    title: String(fields.title || '').slice(0, LIMITS.maxTitle),
    source: validEnum(fields.source, SOURCES) || 'user_explicit',
    sourceType: String(fields.sourceType || ''),
    sourceId: fields.sourceId ?? null,
    sourceMessageId: fields.sourceMessageId ?? null,
    sourceConversationId: fields.sourceConversationId ?? null,
    importance: validEnum(fields.importance, IMPORTANCE_LEVELS) || 'normal',
    confidence: clamp01(fields.confidence ?? 0.8),
    isActive: fields.isActive !== false,
    userConfirmed: fields.userConfirmed === true,
    createdAt: now,
    updatedAt: now,
    expiresAt: fields.expiresAt ?? null,
    lastUsedAt: null,
    assistantId: sanitizeAssistantId(doc, fields.assistantId),
  };
  arr.unshift(mem);
  return mem;
}

// 按 user_id + category + key 去重：同 key 更新原记录而非无限新增（section 四）
export function upsertMemory(doc, fields = {}) {
  const category = normalizeCategory(fields.category);
  const key = String(fields.key || '').trim();
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : ((doc.ai = doc.ai || {}).memories = []);
  const existing = key
    ? arr.find((m) => normalizeCategory(m.category) === category && String(m.key || '').trim() === key)
    : null;
  if (existing) {
    return updateMemory(doc, existing.id, fields);
  }
  return createMemory(doc, { ...fields, category, key });
}

export function updateMemory(doc, id, patch = {}) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const m = arr.find((x) => x.id === id);
  if (!m) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
  // 敏感信息复核（含新 value）
  if (patch.value !== undefined || patch.summary !== undefined || patch.content !== undefined) {
    const probe = String(patch.summary || patch.content || m.summary || '') + ' ' + JSON.stringify(patch.value ?? '');
    const sensitive = detectSensitive(probe);
    if (sensitive) throw new HttpError(422, 'SENSITIVE_CONTENT', `检测到敏感信息（${sensitive}），不会保存原文`);
  }
  enforceLimits(patch);
  if (patch.summary !== undefined || patch.content !== undefined) {
    const s = String(patch.summary ?? patch.content ?? '').trim();
    m.summary = s; m.content = s;
  }
  if (patch.title !== undefined) m.title = String(patch.title);
  if (patch.key !== undefined) m.key = String(patch.key);
  if (patch.value !== undefined) m.value = patch.value;
  if (patch.category !== undefined) m.category = normalizeCategory(patch.category);
  if (patch.source !== undefined) m.source = validEnum(patch.source, SOURCES) || m.source;
  if (patch.importance !== undefined) m.importance = validEnum(patch.importance, IMPORTANCE_LEVELS) || 'normal';
  if (patch.confidence !== undefined) m.confidence = clamp01(patch.confidence);
  if (patch.isActive !== undefined) m.isActive = patch.isActive !== false;
  if (patch.userConfirmed !== undefined) m.userConfirmed = patch.userConfirmed === true;
  if (patch.expiresAt !== undefined) m.expiresAt = patch.expiresAt;
  if (patch.assistantId !== undefined) m.assistantId = sanitizeAssistantId(doc, patch.assistantId);
  m.updatedAt = Date.now();
  return normalizeMemory(m);
}

export function deleteMemory(doc, id) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const before = arr.length;
  doc.ai.memories = arr.filter((x) => x.id !== id);
  return doc.ai.memories.length < before;
}

export function deactivateMemory(doc, id) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const m = arr.find((x) => x.id === id);
  if (!m) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
  m.isActive = false;
  m.updatedAt = Date.now();
  return normalizeMemory(m);
}

export function restoreMemory(doc, id) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const m = arr.find((x) => x.id === id);
  if (!m) throw new HttpError(404, 'NOT_FOUND', '记忆不存在');
  m.isActive = true;
  m.updatedAt = Date.now();
  return normalizeMemory(m);
}

export function clearMemories(doc) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const count = arr.length;
  doc.ai.memories = [];
  return count;
}

export function getMemory(doc, id) {
  return getMemories(doc).find((m) => m.id === id) || null;
}

// ---------------- 查询 / 相关性（无 Embedding，确定性打分） ----------------

export function listMemories(doc, { category = null, query = '', includeInactive = false } = {}) {
  let list = includeInactive ? getMemories(doc) : activeMemories(doc);
  if (category) {
    const c = normalizeCategory(category);
    list = list.filter((m) => m.category === c);
  }
  if (query && String(query).trim()) {
    const q = String(query).trim();
    list = list.filter((m) => (m.summary + ' ' + m.title + ' ' + m.key).toLowerCase().includes(q.toLowerCase()));
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 重要性权重（section 八）：critical > high > normal > low，明确、可读；非法值回退 1。
export function importanceWeight(importance) {
  return { low: 0, normal: 1, high: 2, critical: 3 }[importance] ?? 1;
}

function relevanceScore(m, q) {
  const summary = String(m.summary || '').toLowerCase();
  const key = String(m.key || '').toLowerCase();
  const title = String(m.title || '').toLowerCase();
  const ql = String(q || '').trim().toLowerCase();
  if (!ql) return 0;
  let score = 0;
  if (summary.includes(ql) || key.includes(ql) || title.includes(ql)) score += 5;
  for (const tk of ql.split(/[\s,，。;；:：、!！?？]+/).filter(Boolean)) {
    if (tk.length < 2) continue;
    if (summary.includes(tk)) score += 2;
    if (key.includes(tk) || title.includes(tk)) score += 1;
  }
  const impW = importanceWeight(m.importance);
  return score + impW;
}

export function searchMemories(doc, query, { limit = 20 } = {}) {
  return listMemories(doc, { query, includeInactive: true }).slice(0, limit);
}

// 取与当前任务/话题相关的记忆（相关优先 → 重要性 → 最近使用）
// 先按 category+key（无 key 则 summary）去重，避免两条冲突的 active 记忆同时注入（section 九）。
export function getRelevantMemories(doc, { query = '', limit = LIMITS.injectCount } = {}) {
  let list = scoped(activeMemories(doc), doc);
  const q = String(query || '').trim();
  if (q) {
    list = list
      .map((m) => ({ m, score: relevanceScore(m, q) }))
      .sort((a, b) => b.score - a.score || importanceWeight(b.m.importance) - importanceWeight(a.m.importance) || (b.m.updatedAt || 0) - (a.m.updatedAt || 0))
      .map((x) => x.m);
  } else {
    list = list.sort((a, b) => importanceWeight(b.importance) - importanceWeight(a.importance) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  // 去重：同 category+key（或同 summary）只保留最新一条，杜绝上下文里两条相互矛盾的 active 记忆
  const seen = new Set();
  list = list.filter((m) => {
    const k = m.category + '|' + (String(m.key || '').trim() || String(m.summary || '').trim());
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return list.slice(0, Math.max(1, Math.min(limit, LIMITS.injectCount)));
}

// ---------------- 上下文注入（section 九） ----------------

// 组装注入给 AI 的记忆文本（受数量 + 字符预算限制 + 去重 + 过期/inactive 过滤 + 助手作用域）
export function buildMemoryContext(doc, { query = '', limit = LIMITS.injectCount, maxChars = LIMITS.injectChars } = {}) {
  if (!isEnabled(doc)) return { text: '', memories: [] };
  const memories = getRelevantMemories(doc, { query, limit });
  if (!memories.length) return { text: '', memories: [] };

  const lines = [];
  let budget = 0;
  const preamble = '以下是关于用户的长期记忆（不保证绝对正确；若与用户当前表达冲突，以用户当前表达为准；不要把记忆当绝对事实；不要主动向用户暴露「系统记忆结构」；若某条记忆明显过期，可请求用户确认或更新）。';
  budget += preamble.length;
  for (const m of memories) {
    const label = CATEGORY_LABELS[m.category] || m.category;
    const text = m.title ? `${m.title}：${m.summary}` : m.summary;
    const line = `- [${label}] ${text}`;
    if (budget + line.length + 1 > maxChars) break;
    lines.push(line);
    budget += line.length + 1;
  }
  const body = lines.join('\n');
  return { text: `<user_memory>\n${preamble}\n\n${body}\n</user_memory>`, memories };
}

// 标记记忆被使用（更新 lastUsedAt，供相关性排序）
export function touchMemory(doc, id) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const m = arr.find((x) => x.id === id);
  if (m) m.lastUsedAt = Date.now();
}

// ---------------- 写入规则（section 六 / 七） ----------------

// 判断一段文本是否值得进入记忆候选（确定性，非 AI）。
// 返回 { action: 'save' | 'ask' | 'ignore', reason }
export function shouldRemember(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return { action: 'ignore', reason: 'too_short' };
  if (detectSensitive(t)) return { action: 'ignore', reason: 'sensitive' };
  const explicit = /记住|记得|别忘了|以后都|请保存|保存一下|记一下|以后叫我|以后叫|记牢|别忘|下次别忘|以后你叫/.test(t);
  if (explicit) return { action: 'save', reason: 'explicit_request' };
  const pref = /我喜欢|我不喜欢|我习惯|我偏好|我总是|我每次|我通常|我不爱/.test(t);
  if (pref) return { action: 'ask', reason: 'preference_signal' };
  return { action: 'ignore', reason: 'no_signal' };
}

// 记忆冲突：返回同 category+key 的现有 active 记录（若有）
export function detectMemoryConflict(doc, { category, key }) {
  if (!key) return null;
  const c = normalizeCategory(category);
  const k = String(key).trim();
  return activeMemories(doc).find((m) => m.category === c && String(m.key || '').trim() === k) || null;
}

// 合并重复：按 summary 去重（保留最新一条 active，其余停用）
export function mergeDuplicateMemories(doc) {
  const arr = (doc.ai && Array.isArray(doc.ai.memories)) ? doc.ai.memories : [];
  const seen = new Map();
  for (const m of arr) {
    const k = String(m.summary || '').trim();
    if (!k) continue;
    if (seen.has(k)) { m.isActive = false; }
    else seen.set(k, m);
  }
  return arr.length;
}

// ---------------- 候选记忆（section 六 / 七） ----------------

// 取全部候选（含已确认/已拒绝，供清理）；只返回原始条目，不做状态过滤
function rawCandidates(doc) {
  return (doc && doc.ai && Array.isArray(doc.ai.memoryCandidates)) ? doc.ai.memoryCandidates : [];
}

// 清理过期候选 + 限制总数：过期/已处理的超出上限的部分移除，绝不无限累积
export function cleanupExpiredCandidates(doc) {
  const now = Date.now();
  const arr = rawCandidates(doc);
  const pending = arr.filter((c) => c.status === 'pending' && (!c.expiresAt || c.expiresAt > now));
  // 保留：所有 pending（受上限约束）+ 最近已处理的（供「勿重复询问」标记，最多保留少量）
  const resolved = arr.filter((c) => c.status !== 'pending').slice(0, CANDIDATE_LIMITS.maxPending);
  doc.ai.memoryCandidates = [...pending.slice(0, CANDIDATE_LIMITS.maxPending), ...resolved];
  return arr.length - doc.ai.memoryCandidates.length;
}

// 待确认候选（status=pending 且未过期）
export function getPendingCandidates(doc) {
  const now = Date.now();
  return rawCandidates(doc).filter((c) => c.status === 'pending' && (!c.expiresAt || c.expiresAt > now));
}

// 新增一条待确认候选。独立于正式记忆，绝不进 ai.memories / 上下文。
// 按 summary 去重（同内容不再重复建候选）；达数量上限返回 null。
export function addCandidate(doc, fields = {}) {
  cleanupExpiredCandidates(doc);
  const summary = String(fields.summary || fields.content || '').trim();
  if (!summary) return null;
  if (detectSensitive(summary + ' ' + JSON.stringify(fields.value ?? ''))) return null; // 敏感信息连候选都不建
  const arr = doc.ai.memoryCandidates || (doc.ai.memoryCandidates = []);
  const dup = arr.find((c) => c.status === 'pending' && String(c.summary || '') === summary);
  if (dup) return dup;
  if (arr.filter((c) => c.status === 'pending').length >= CANDIDATE_LIMITS.maxPending) return null;
  const now = Date.now();
  const cand = {
    id: randomUUID(),
    status: 'pending',
    category: normalizeCategory(fields.category),
    key: String(fields.key || '').slice(0, LIMITS.maxKey),
    value: fields.value !== undefined ? fields.value : null,
    summary,
    content: summary,
    title: String(fields.title || '').slice(0, LIMITS.maxTitle),
    source: validEnum(fields.source, SOURCES) || 'ai_extracted',
    sourceType: String(fields.sourceType || ''),
    sourceId: fields.sourceId ?? null,
    importance: validEnum(fields.importance, IMPORTANCE_LEVELS) || 'normal',
    confidence: clamp01(fields.confidence ?? 0.6),
    createdAt: now,
    expiresAt: now + CANDIDATE_LIMITS.expiryMs,
    rejectedAt: null,
    rejectedCount: 0,
    assistantId: sanitizeAssistantId(doc, fields.assistantId),
  };
  arr.unshift(cand);
  return cand;
}

// 确认候选 → 转正为正式记忆（userConfirmed=true，进入 ai.memories）
export function confirmCandidate(doc, id) {
  const arr = rawCandidates(doc);
  const c = arr.find((x) => x.id === id);
  if (!c || c.status !== 'pending') throw new HttpError(404, 'NOT_FOUND', '候选记忆不存在或已处理');
  const mem = createMemory(doc, {
    category: c.category, key: c.key, value: c.value, summary: c.summary, title: c.title,
    source: c.source, sourceType: c.sourceType, importance: c.importance, confidence: c.confidence,
    userConfirmed: true, assistantId: c.assistantId,
  });
  c.status = 'confirmed';
  return mem;
}

// 拒绝候选 → 标记 rejected（记录次数，供「勿重复询问」）；不会变成正式记忆
export function rejectCandidate(doc, id) {
  const arr = rawCandidates(doc);
  const c = arr.find((x) => x.id === id);
  if (!c || c.status !== 'pending') throw new HttpError(404, 'NOT_FOUND', '候选记忆不存在或已处理');
  c.status = 'rejected';
  c.rejectedAt = Date.now();
  c.rejectedCount = (c.rejectedCount || 0) + 1;
  return c;
}

// 偏好信号计数（balanced 模式的重复检测）。key 归一化后按次累加，带过期。
export function notePreferenceSignal(doc, key, { expiryMs = CANDIDATE_LIMITS.expiryMs } = {}) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  const arr = doc.ai.memorySignals || (doc.ai.memorySignals = []);
  const now = Date.now();
  let sig = arr.find((s) => s.key === k && s.expiresAt > now);
  if (sig) { sig.count = (sig.count || 0) + 1; sig.lastAt = now; }
  else { sig = { key: k, count: 1, firstAt: now, lastAt: now, expiresAt: now + expiryMs }; arr.push(sig); }
  // 清理过期信号，保留最近 50 条
  doc.ai.memorySignals = arr.filter((s) => s.expiresAt > now).slice(-50);
  return sig;
}

// 是否已明确要求（「记住/以后都…」），供 confirm 流程判断
function isExplicit(fields) {
  return fields.userConfirmed === true || fields.source === 'user_explicit';
}

// 根据 confirmationMode 决定一段文本 / 一条记忆应「保存 / 候选 / 忽略」。
// - explicit_only：只有明确要求才保存；推断偏好一律忽略（不自动存）。
// - ask_before_save：明确→保存；推断稳定偏好→候选（待确认，不写正式记忆）。
// - balanced：明确→保存；低风险稳定偏好需「重复出现」才提议候选；敏感/高风险绝不自动。
export function decideMemoryAction(doc, text) {
  const r = shouldRemember(text);
  if (r.action !== 'ask') return r; // save（明确）/ ignore（无信号或敏感）直接透传
  const mode = memorySettings(doc).confirmationMode;
  if (mode === 'explicit_only') return { action: 'ignore', reason: 'explicit_only' };
  if (mode === 'balanced') {
    const sig = notePreferenceSignal(doc, text);
    if ((sig && sig.count) < 2) return { action: 'ignore', reason: 'not_repeated' };
    return { action: 'candidate', reason: 'repeated_preference' };
  }
  // ask_before_save（默认）
  return { action: 'candidate', reason: r.reason };
}

// 实际落库入口（供 AI 工具调用）：按 confirmationMode 路由到正式记忆 / 候选 / 忽略。
export function proposeMemory(doc, fields = {}) {
  if (!isEnabled(doc)) throw new HttpError(403, 'MEMORY_DISABLED', '记忆功能已关闭');
  if (isExplicit(fields)) {
    return { action: 'save', memory: upsertMemory(doc, { ...fields, userConfirmed: true }) };
  }
  if (!autoSaveEnabled(doc)) return { action: 'ignore', reason: 'auto_save_disabled' };
  const mode = memorySettings(doc).confirmationMode;
  if (mode === 'explicit_only') return { action: 'ignore', reason: 'explicit_only' };
  // balanced：仅「偏好类」推断需「重复出现」才提议候选；其他类别（重要对话等）直接进候选
  const cat = normalizeCategory(fields.category);
  if (mode === 'balanced' && cat === 'preference') {
    const sig = notePreferenceSignal(doc, String(fields.key || fields.summary || '').trim());
    if (!sig || sig.count < 2) return { action: 'ignore', reason: 'not_repeated' };
  }
  const candidate = addCandidate(doc, fields);
  return candidate ? { action: 'candidate', candidate } : { action: 'ignore', reason: 'candidate_limit' };
}

// ---------------- 便捷写入（section 五） ----------------

export function upsertProfileMemory(doc, key, value, opts = {}) {
  const summary = typeof value === 'string' ? value : (opts.summary || JSON.stringify(value ?? ''));
  return upsertMemory(doc, {
    category: 'profile', key, value, summary,
    source: opts.source || 'user_explicit',
    importance: opts.importance || 'high',
    userConfirmed: opts.userConfirmed !== false,
    assistantId: opts.assistantId,
  });
}

export function upsertPreferenceMemory(doc, key, value, opts = {}) {
  const summary = typeof value === 'string' ? value : (opts.summary || JSON.stringify(value ?? ''));
  return upsertMemory(doc, {
    category: 'preference', key, value, summary,
    source: opts.source || 'user_explicit',
    importance: opts.importance || 'normal',
    userConfirmed: opts.userConfirmed !== false,
    assistantId: opts.assistantId,
  });
}

// 重要对话摘要（section 十四）：只存摘要，绝不存整段原文
export function saveImportantConversation(doc, fields = {}) {
  const summary = String(fields.summary || '').trim();
  if (!summary) throw new HttpError(400, 'INVALID', '摘要不能为空');
  const value = {
    title: fields.title || '',
    keyPoints: Array.isArray(fields.keyPoints) ? fields.keyPoints.slice(0, 20) : [],
    relatedTopic: fields.relatedTopic || '',
    sourceConversationId: fields.sourceConversationId ?? null,
    sourceMessageIds: Array.isArray(fields.sourceMessageIds) ? fields.sourceMessageIds.slice(0, 50) : [],
  };
  return createMemory(doc, {
    category: 'important_conversation',
    key: fields.key || ('conv_' + Date.now().toString(36)),
    value,
    summary,
    title: fields.title || '',
    source: fields.source || 'ai_extracted',
    importance: fields.importance || 'high',
    userConfirmed: fields.userConfirmed === true,
    sourceConversationId: fields.sourceConversationId,
  });
}
