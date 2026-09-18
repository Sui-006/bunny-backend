// 对话风格画像（Conversation Style Profile）服务。
// 目标：让 AI 换新聊天窗口后，聊天语气、称呼、互动习惯稳定延续。
//
// 三样东西严格分离（绝不互相替代、绝不重复保存同一内容）：
//   - AI Memory（memory-service，doc.ai.memories）：长期事实、重要信息、长期偏好。
//   - Conversation Cache（conversation-cache，sessions.cache_*）：当前话题/要点/决定/未完成。
//   - Conversation Style Profile（本服务，doc.ai.styleProfile）：AI 该怎样和用户聊天（语气/称呼/回答长度倾向）。
//
// 关键约束：
//   - user-level：存 users.user_state 的 doc.ai.styleProfile，绝不绑定 conversationId；新开 Conversation B
//     读的是同一个用户级画像，天然跨窗口继承。
//   - 绝不每轮「聊天→分析风格→重建画像→写库」：只有「明确偏好（立即）」或「重复行为（达阈值）」才更新；
//     单次行为默认只影响当前对话（靠「以用户当前要求为准」+ 当前消息在上下文里生效），不永久改画像。
//   - 只从真实 user message 学习（确定性规则，绝不调 AI 逐轮分析）；tool JSON / tool result / system prompt /
//     hidden reasoning / 内部 XML 协议绝不进入画像（下方 INTERNAL_XML_RE 兜底拒绝）。
//   - 注入的是轻量 styleContext（<= STYLE_BUDGET tokens），绝不把完整 JSON 原样发给模型。
import { withDocVersioned } from '../lib/domain.js';
import { BUDGETS, truncateByTokens } from '../lib/context-budget.js';

// 重复行为触发稳定更新的阈值：同一风格信号出现 >= 2 次才写入画像（避免一次「简单说」永久等于 concise）。
export const STYLE_SIGNAL_THRESHOLD = 2;
const STYLE_SIGNAL_EXPIRY_MS = 7 * 24 * 3600 * 1000; // 信号计数 7 天过期

export const DEFAULT_STYLE_PROFILE = {
  tone: null,            // 语气基调：natural（自然/亲切/不生硬）等
  formality: null,       // 正式程度：casual（自然/亲近/非客服式）| formal
  verbosity: null,       // 简洁/详细：concise | balanced | detailed
  humor: null,           // 幽默程度：low | medium | high
  technicalDetail: null, // 技术问题详细程度：concise | detailed | structured
  address: null,         // 称呼方式（如「岁岁」）—— 是「怎么称呼用户」，绝不硬编码助手自己的名字
  dislikes: [],          // 用户不喜欢的表达方式
  habits: [],            // 稳定互动习惯
  confidence: 0,
  source: null,          // user_explicit | repeated_behavior
  version: 0,
  updatedAt: 0,
};

// 内部协议 / 工具残留 / 隐藏推理的兜底指纹。命中即拒绝作为风格来源。
const INTERNAL_XML_RE = /(?:<\s*(?:antml:)?(?:function_calls|function_call|invoke|parameter|tool_call|tool_use|thinking)\b|<\?xml\b|"tool_call_id"\s*:|"role"\s*:\s*"tool")/i;

// 把缺失/畸形画像规整为统一形状（读时、写时都走这里，避免双形状并存）。
export function normalizeStyleProfile(doc) {
  if (!doc.ai || typeof doc.ai !== 'object') doc.ai = {};
  let p = doc.ai.styleProfile;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    p = { ...DEFAULT_STYLE_PROFILE, dislikes: [], habits: [] };
    doc.ai.styleProfile = p;
  }
  for (const k of Object.keys(DEFAULT_STYLE_PROFILE)) {
    if (p[k] === undefined) p[k] = DEFAULT_STYLE_PROFILE[k];
  }
  // 数组字段必须是独立实例，绝不与 DEFAULT_STYLE_PROFILE 共享引用（否则一个文档 push 会污染所有文档）。
  if (!Array.isArray(p.dislikes) || p.dislikes === DEFAULT_STYLE_PROFILE.dislikes) p.dislikes = [];
  if (!Array.isArray(p.habits) || p.habits === DEFAULT_STYLE_PROFILE.habits) p.habits = [];
  return p;
}

// 画像里是否真的有「内容」字段（用于决定要不要注入 styleContext）。
function hasContent(p) {
  return !!(p.address || p.tone || p.formality || p.verbosity || p.humor || p.technicalDetail || p.dislikes.length || p.habits.length);
}

// ---------------- 学习：明确偏好（立即更新，高置信度） ----------------
// 只识别带「稳定指令」锚点的表达（以后/从今往后/从现在起/每次/总是/别/不要/叫我），
// 这类表达是用户明确要求长期如此，应作为高置信度偏好立即更新画像。
// 返回 { fields, dislikes } 或 null；绝不识别 tool/XML/隐藏推理文本。
export function detectExplicitStylePreference(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return null;
  if (INTERNAL_XML_RE.test(t)) return null;

  const fields = {};
  const dislikes = [];

  // 称呼：叫我 XX（天然是长期偏好，无需其它锚点）
  const addr = t.match(/(?:以后|从今往后|从现在起|请|就)?(?:都)?(?:可以)?(?:你)?叫我[「"“'']?([^\s，。！？、,.!?;；:：'"”’]{1,12})/);
  if (addr && addr[1] && !/[我你他她它咱自]/.test(addr[1])) {
    fields.address = addr[1];
  }

  // 语气：以后说话自然/亲切/随和/温柔一点；别/不要那么生硬
  if (/(?:以后|从今往后|从现在起)(?:说话|语气|回复|回答)?(?:要|再|更)?(?:自然|亲切|随和|温柔|轻松)(?:一点|点)?/.test(t)
      || /(?:别|不要)(?:那么|这么)?生硬/.test(t)) {
    fields.tone = 'natural';
  }

  // 正式度：别/不要 那么官方/正式/客套/像客服 → casual
  if (/(?:别|不要)(?:那么|这么)?(?:官方|正式|客套)/.test(t)
      || /(?:别|不要)(?:那么|这么)?(?:像|跟|弄得|搞得)?(?:个|得|成)?(?:像)?客服/.test(t)) {
    fields.formality = 'casual';
    if (/客服/.test(t)) dislikes.push('不要像客服');
    else if (/官方/.test(t)) dislikes.push('不要太官方');
    else dislikes.push('不要太正式/客套');
  }

  // 简洁：别/不要（每次/总是）解释那么长 / 啰嗦 / 那么详细
  if (/(?:别|不要)(?:每次|总是|都)?(?:给我)?(?:解释|说|写|回答|回复|讲)?(?:得|的)?(?:那么|这么)?(?:长|啰嗦|啰里啰嗦|一大堆)/.test(t)
      || /(?:别|不要)(?:那么|这么)?(?:详细|复杂)/.test(t)
      || /(?:以后|从今往后|从现在起|每次|总是)(?:回复|回答|解释|说|讲)?(?:要|就)?(?:简洁|简单|简短|短)(?:一点|点)?/.test(t)) {
    fields.verbosity = 'concise';
  }

  // 详细：以后/每次 要详细/具体/展开
  if (/(?:以后|从今往后|从现在起|每次|总是)(?:回复|回答|解释|说|讲)?(?:要|就)?(?:详细|具体|展开)(?:一点|点|讲讲|讲)?/.test(t)) {
    fields.verbosity = 'detailed';
  }

  // 幽默：以后/多/经常 开开玩笑/幽默；别/不要那么严肃
  if (/(?:以后|从今往后|多|经常)(?:开开玩笑|开玩笑|幽默|来点幽默|讲个笑话)/.test(t)
      || /(?:别|不要)(?:那么|这么)?严肃/.test(t)) {
    fields.humor = 'high';
  }

  if (Object.keys(fields).length === 0 && dislikes.length === 0) return null;
  return { fields, dislikes };
}

// ---------------- 学习：重复行为（达阈值才更新，避免过度推断） ----------------
// 只识别「裸风格提示」（无稳定指令锚点），如「简单一点/详细一点/自然一点/幽默一点」。
// 这类表达先只累加计数；连续出现达到阈值才写入画像。单次行为绝不永久改画像。
export function classifyStyleSignal(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  if (INTERNAL_XML_RE.test(t)) return null;
  // 已带「明确指令」锚点的走 detectExplicitStylePreference，这里不算重复信号
  if (/以后|从今往后|从现在起|每次|总是|别|不要|叫我/.test(t)) return null;

  if (/(?:说话|语气|回复|回答|解释|说|写|讲)?(?:简单|简洁|简短|短)一点|长话短说|说重点/.test(t)) return { key: 'verbosity_concise' };
  if (/(?:说话|语气|回复|回答|解释|说|写|讲)?(?:详细|具体)一点|展开讲讲|详细说说|说详细/.test(t)) return { key: 'verbosity_detailed' };
  if (/(?:说话|语气|回复|回答)?(?:自然|亲切|随和|温柔|轻松)一点/.test(t)) return { key: 'tone_natural' };
  if (/幽默一点|来点幽默|开开玩笑|多开开玩笑/.test(t)) return { key: 'humor_high' };
  return null;
}

const SIGNAL_FIELDS = {
  verbosity_concise: { verbosity: 'concise' },
  verbosity_detailed: { verbosity: 'detailed' },
  tone_natural: { tone: 'natural' },
  humor_high: { humor: 'high' },
};

// ---------------- 写入 ----------------

// 把一次风格更新合入画像（字段覆盖、dislikes 去重合并、version/source/confidence/updatedAt 落库）。
// 返回更新后的画像，或 null（本次没有任何字段变化，调用方应视为 no-op）。
export function applyStyleUpdate(doc, { fields = {}, dislikes = [] }, { source, confidence }) {
  const p = normalizeStyleProfile(doc);
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (p[k] !== v) { p[k] = v; changed = true; }
  }
  for (const d of dislikes) {
    const s = String(d || '').trim();
    if (s && !p.dislikes.includes(s)) { p.dislikes.push(s); changed = true; }
  }
  if (p.dislikes.length > 8) p.dislikes = p.dislikes.slice(-8);
  if (!changed) return null;
  p.source = source;
  p.confidence = confidence;
  p.version = (Number(p.version) || 0) + 1;
  p.updatedAt = Date.now();
  return p;
}

// 偏好信号计数（重复检测）。key 归一化后按次累加，带过期，绝不无限累积。
export function noteStyleSignal(doc, key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  if (!doc.ai || typeof doc.ai !== 'object') doc.ai = {};
  const arr = doc.ai.styleSignals || (doc.ai.styleSignals = []);
  const now = Date.now();
  let sig = arr.find((s) => s.key === k && s.expiresAt > now);
  if (sig) { sig.count = (sig.count || 0) + 1; sig.lastAt = now; }
  else { sig = { key: k, count: 1, firstAt: now, lastAt: now, expiresAt: now + STYLE_SIGNAL_EXPIRY_MS }; arr.push(sig); }
  doc.ai.styleSignals = arr.filter((s) => s.expiresAt > now).slice(-50);
  return sig;
}

// ---------------- 上下文注入（轻量，绝不发完整 JSON） ----------------

// 把画像渲染成一段短小的 styleContext。只渲染已设置字段，正常远低于 STYLE_BUDGET。
// 绝不硬编码助手自己的名字（助手名统一走 RULES_PREAMBLE / 助手配置，画像只负责「怎么称呼用户」等互动风格）。
export function buildStyleContext(doc) {
  const p = normalizeStyleProfile(doc);
  if (!hasContent(p)) return '';

  const lines = [];
  if (p.address) lines.push(`- 称呼用户：${p.address}`);
  if (p.tone === 'natural') lines.push('- 语气：自然、亲切，不生硬');
  else if (p.tone) lines.push(`- 语气：${p.tone}`);
  if (p.formality === 'casual') lines.push('- 正式度：自然、亲近、非客服式');
  else if (p.formality === 'formal') lines.push('- 正式度：偏正式');
  if (p.verbosity === 'concise') lines.push('- 简洁度：偏简洁、抓重点，不展开无关细节');
  else if (p.verbosity === 'detailed') lines.push('- 简洁度：可以详细、展开');
  else if (p.verbosity === 'balanced') lines.push('- 简洁度：适中，视情况');
  if (p.humor === 'high') lines.push('- 幽默：可以适度幽默、轻松');
  else if (p.humor === 'low') lines.push('- 幽默：少开玩笑，保持认真');
  if (p.technicalDetail === 'detailed') lines.push('- 技术问题：详细、结构化');
  else if (p.technicalDetail === 'concise') lines.push('- 技术问题：简洁、点到为止');
  if (p.dislikes.length) lines.push(`- 避免：${p.dislikes.join('、')}`);
  if (p.habits.length) lines.push(`- 习惯：${p.habits.join('、')}`);

  if (!lines.length) return '';
  const text = '【互动风格】以下是你与用户的默认互动风格（不是绝对限制；若用户当前消息有明确不同要求，以用户当前要求为准）：\n' + lines.join('\n');
  return truncateByTokens(text, BUDGETS.STYLE_BUDGET);
}

// ---------------- 编排：每轮入口（纯检测先行，命中才碰数据库） ----------------
// 明确偏好 → 立即更新；重复行为 → 计数，达阈值才更新；其它 → 完全不碰数据库（绝不每轮写库）。
export async function maybeLearnStyle(userId, content) {
  const explicit = detectExplicitStylePreference(content);
  const signal = explicit ? null : classifyStyleSignal(content);
  if (!explicit && !signal) return { updated: false, reason: 'none' };

  const { result } = await withDocVersioned(userId, (doc) => {
    if (explicit) {
      const patch = applyStyleUpdate(doc, explicit, { source: 'user_explicit', confidence: 0.95 });
      return patch ? { updated: true, reason: 'explicit' } : { updated: false, reason: 'no_change' };
    }
    const sig = noteStyleSignal(doc, signal.key);
    if (sig.count >= STYLE_SIGNAL_THRESHOLD) {
      const patch = applyStyleUpdate(doc, { fields: SIGNAL_FIELDS[signal.key] || {} }, { source: 'repeated_behavior', confidence: 0.7 });
      return patch ? { updated: true, reason: 'repeated' } : { updated: false, reason: 'no_change' };
    }
    return { updated: false, reason: 'signal_counted' };
  });
  return result;
}
