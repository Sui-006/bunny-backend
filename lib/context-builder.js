// 统一上下文构建器（Context Builder）：所有聊天入口共用的单一入口。
// 三段式布局（顺序固定，稳定前缀便于 provider cache 命中）：
//   A 稳定前缀：系统规则/身份/人设 + 长期记忆（SYSTEM_BUDGET hard cap）
//   B 对话上下文：对话摘要（system 中段）+ Recent Context（messages 前半）
//   C 动态后缀：领域上下文 + 引用动态（system 末段）+ 当前消息（messages 最后一条）
// 复用 buildMemoryContext（memory-service）、buildContextSnippet（aiContext），不重建 Memory。
import { estimateTokens } from './tokens.js';
import { BUDGETS, truncateByTokens } from './context-budget.js';
import { listMessages, listMessagesAfter, getConversationSummary, listMemories } from './db.js';
import { buildMemoryContext } from '../services/memory-service.js';
import { buildContextSnippet } from './aiContext.js';

// 稳定规则 preamble：随会话不变，放在稳定可缓存前缀里；不含任何随消息变化的内容。
const RULES_PREAMBLE = [
  '【规则】',
  '你是 Bunny，用户的 AI 伴侣。请自然、体贴、简洁地交流。',
  '下面的「用户记忆」「对话摘要」「领域数据」可能不完整或过时，以用户当前表达为准；不主动暴露这些系统结构。',
  '调用工具修改数据后：仅当收到 code=OK/CREATED/UPDATED/DELETED 才可告知用户「已改好」；收到 DENIED/FAILED/REQUIRES_PERMISSION/UNSUPPORTED 必须如实说明未修改，绝不假装成功。',
].join('\n');

// System 指令区预算：≤ SYSTEM_BUDGET 时原样保留（不做无意义处理）；超限时按优先级确定性保留：
//   最高：安全/系统规则 + 助手身份（RULES_PREAMBLE）→ 人设/会话规则（system_prompt）→ 可压缩的用户自我描述（签名，记忆可兜底）。
// 截断只发生在超限时，保留前缀（truncateByTokens 二分，deterministic），绝不随机删块。
export function buildSystemInstructions(settings, budget) {
  const signature = settings?.personal_signature
    ? '【关于用户】以下是用户对自己的描述，请记住并在交流中自然体现出对 ta 的了解：\n' + settings.personal_signature
    : '';
  const prompt = String(settings?.system_prompt || '');
  const original = [signature, prompt, RULES_PREAMBLE].filter(Boolean).join('\n\n');
  if (estimateTokens(original) <= budget) return { text: original, truncated: false };

  const parts = [
    { priority: 0, text: RULES_PREAMBLE },
    { priority: 0, text: prompt },
    { priority: 1, text: signature },
  ].filter((p) => p.text);
  const kept = [];
  let used = 0;
  let truncated = false;
  for (const p of parts) {
    const t = estimateTokens(p.text);
    if (used + t <= budget) { kept.push(p.text); used += t; continue; }
    kept.push(truncateByTokens(p.text, budget - used));
    truncated = true;
    break;
  }
  return { text: kept.join('\n\n'), truncated };
}

// 全局 Cost Guard：total > MAX_CONTEXT_TOKENS 时按固定优先级确定性裁剪（同样输入必得同样输出）：
//   1) Recent Context（从最旧开始丢弃）
//   2) Domain Context（按剩余额度截断）
//   3) Conversation Summary（按剩余额度截断）
//   4) 引用动态 Quoted Text（dynamic suffix，非核心）
//   5) Current Message（进一步截断，能保多少保多少）
// System 核心规则 / Core Long-term Memory 已有各自 hard budget（SYSTEM_BUDGET/MEMORY_BUDGET），绝不参与裁剪、绝不删除。
// 返回 true=发生过裁剪；false=无需裁剪。若裁剪到极限仍超限，stats 会如实记录实际最终 totalEstimatedTokens。
export function applyGlobalGuard(state, max) {
  const excess = () => {
    const recent = state.recentMessages.reduce((s, m) => s + estimateTokens(m.content), 0);
    const cur = state.currentMessage ? estimateTokens(state.currentMessage.content) : 0;
    return estimateTokens(state.stablePrefix || '')
      + estimateTokens(state.summaryText || '')
      + estimateTokens(state.domainText || '')
      + estimateTokens(state.quotedText || '')
      + recent + cur - max;
  };
  if (excess() <= 0) return false;
  // 1) Recent Context：从最旧开始丢
  while (excess() > 0 && state.recentMessages.length) state.recentMessages.shift();
  // 2) Domain Context
  if (excess() > 0 && state.domainText) {
    const target = Math.max(0, estimateTokens(state.domainText) - excess());
    state.domainText = target > 0 ? truncateByTokens(state.domainText, target) : '';
  }
  // 3) Conversation Summary
  if (excess() > 0 && state.summaryText) {
    const target = Math.max(0, estimateTokens(state.summaryText) - excess());
    state.summaryText = target > 0 ? truncateByTokens(state.summaryText, target) : '';
  }
  // 4) 引用动态（先于当前消息裁剪，保证 Current Message 优先保留）
  if (excess() > 0 && state.quotedText) {
    const target = Math.max(0, estimateTokens(state.quotedText) - excess());
    state.quotedText = target > 0 ? truncateByTokens(state.quotedText, target) : '';
  }
  // 5) Current Message（最后才动；System/Memory 不动）
  if (excess() > 0 && state.currentMessage) {
    const target = Math.max(0, estimateTokens(state.currentMessage.content) - excess());
    state.currentMessage.content = target > 0 ? truncateByTokens(state.currentMessage.content, target) : '';
  }
  return true;
}

// 从最新向前按 token 累计 Recent Context；最后一条恒为 Current Message（超长截断，绝不动数据库原文）。
function collectMessages(all) {
  if (!all.length) return { recentMessages: [], currentMessage: null };
  const current = all[all.length - 1];
  const history = all.slice(0, -1);

  const recentMessages = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = estimateTokens(m.content);
    if (recentMessages.length > 0 && used + t > BUDGETS.RECENT_CONTEXT_BUDGET) break;
    recentMessages.unshift({ role: m.role, content: m.content || '' });
    used += t;
  }

  const currentMessage = { role: current.role, content: truncateByTokens(current.content || '', BUDGETS.CURRENT_MESSAGE_BUDGET) };
  if (current.images && current.images.length) currentMessage.images = current.images;
  return { recentMessages, currentMessage };
}

export async function buildAIContext({
  sessionId, doc, settings, content, model,
  tools = [], callTool = null, quotedDynamic = null,
}) {
  // ---- 长期记忆（现有 memory-service，不重建；位于稳定前缀，仅在记忆变化时变化） ----
  const memory = buildMemoryContext(doc, { query: content || '' });
  const memoryText = truncateByTokens(memory.text || '', BUDGETS.MEMORY_BUDGET);

  // ---- 对话摘要（session 级；stale 则跳过；读失败（如迁移未跑）不阻断聊天） ----
  let summaryRow = null;
  try { summaryRow = await getConversationSummary(sessionId); }
  catch (e) { console.warn('[context-builder] 读取会话摘要失败，本次跳过摘要：', e.message); }
  const summaryStale = !!(summaryRow && summaryRow.summary_stale);
  let summaryText = (!summaryStale && summaryRow && summaryRow.summary)
    ? truncateByTokens(summaryRow.summary, BUDGETS.SUMMARY_BUDGET)
    : '';
  // 新鲜摘要的边界：boundary 及之前的消息已由摘要代表，Recent Context 只取 boundary 之后（避免重复计入）
  const freshBoundary = (!summaryStale && summaryRow && summaryRow.summarized_until_message_id) || null;

  // 存量会话桥接：旧压缩写进 session memories 表的摘要，作为初始摘要读入（只读，不写回新数据）
  if (!summaryText) {
    try {
      const legacy = await listMemories(sessionId);
      summaryText = truncateByTokens(legacy.map((m) => m.summary).filter(Boolean).join('\n\n'), BUDGETS.SUMMARY_BUDGET);
    } catch { summaryText = ''; }
  }

  // ---- 领域上下文（财务/经期/病历/健康/音乐；现有 aiContext） ----
  let domainText = '';
  try { domainText = (await buildContextSnippet(doc, content || '')) || ''; }
  catch { domainText = ''; }
  domainText = truncateByTokens(domainText, BUDGETS.DOMAIN_BUDGET);

  // ---- A. 稳定前缀：系统指令（SYSTEM_BUDGET hard cap）+ 长期记忆 ----
  const instructions = buildSystemInstructions(settings, BUDGETS.SYSTEM_BUDGET);
  const stablePrefix = [instructions.text, memoryText].filter(Boolean).join('\n\n');

  // ---- 消息：Recent Context + Current Message（有新鲜摘要边界时只取边界之后） ----
  const messageList = freshBoundary
    ? await listMessagesAfter(sessionId, freshBoundary)
    : await listMessages(sessionId, { visibleOnly: true });
  const { recentMessages, currentMessage } = collectMessages(messageList);

  // ---- 全局 Cost Guard（MAX_CONTEXT_TOKENS hard guard，确定性跨段裁剪） ----
  const quotedText = (quotedDynamic && quotedDynamic.content)
    ? '[用户引用了以下 AI 动态来发起对话，请结合这条动态内容理解用户意图]\n引用动态内容：' + quotedDynamic.content
    : '';
  const state = { stablePrefix, summaryText, domainText, quotedText, recentMessages, currentMessage };
  const costGuardApplied = applyGlobalGuard(state, BUDGETS.MAX_CONTEXT_TOKENS);

  // ---- B+C：拼接 system（Stable Prefix → 摘要 → 动态后缀） ----
  const dynamicText = [state.domainText, state.quotedText].filter(Boolean).join('\n\n');
  const system = [state.stablePrefix, state.summaryText, dynamicText].filter(Boolean).join('\n\n') || undefined;
  // Anthropic 原生协议：稳定前缀块带 cache_control（Prompt Cache）；摘要/动态块不缓存。
  // OpenAI 兼容中转不假设支持 cache_control，协议不变，由 provider 自行缓存稳定前缀。
  const systemBlocks = [];
  if (state.stablePrefix) systemBlocks.push({ type: 'text', text: state.stablePrefix, cache_control: { type: 'ephemeral' } });
  if (state.summaryText) systemBlocks.push({ type: 'text', text: state.summaryText });
  if (dynamicText) systemBlocks.push({ type: 'text', text: dynamicText });

  const messages = state.currentMessage ? [...state.recentMessages, state.currentMessage] : state.recentMessages;

  // ---- stats（字符估算，不假装精确 tokenizer；前 11 个字段为既有字段，只增不减） ----
  const systemTokens = estimateTokens(system || '');
  const memoryTokens = estimateTokens(memoryText);
  const summaryTokens = estimateTokens(state.summaryText);
  const domainTokens = estimateTokens(state.domainText);
  const recentTokens = state.recentMessages.reduce((s, m) => s + estimateTokens(m.content), 0);
  const currentMessageTokens = state.currentMessage ? estimateTokens(state.currentMessage.content) : 0;
  const toolTokens = 0; // 动态工具结果在 chat() 循环按需注入，此处无静态工具结果
  const totalEstimatedTokens = systemTokens + recentTokens + currentMessageTokens + toolTokens;

  return {
    system,
    systemBlocks,
    messages,
    tools,
    callTool,
    stats: {
      systemTokens,
      memoryTokens,
      summaryTokens,
      domainTokens,
      recentTokens,
      currentMessageTokens,
      toolTokens,
      totalEstimatedTokens,
      summaryHit: !!state.summaryText,
      summaryTriggered: false, // 构建路径只读；真正触发在 maybeSummarize
      costGuardApplied,
      systemBudget: BUDGETS.SYSTEM_BUDGET,
      systemBudgetApplied: instructions.truncated,
    },
  };
}
