// 统一上下文构建器（Context Builder）：所有聊天入口共用的单一入口。
// 组装：稳定 system 前缀（可缓存）+ 长期记忆 + 对话摘要 + 领域上下文 + Recent Context + Current Message。
// 复用 buildMemoryContext（memory-service）、buildContextSnippet（aiContext），不重建 Memory。
import { estimateTokens } from './tokens.js';
import { BUDGETS, truncateByTokens } from './context-budget.js';
import { listMessages, getConversationSummary, listMemories } from './db.js';
import { buildMemoryContext } from '../services/memory-service.js';
import { buildContextSnippet } from './aiContext.js';

// 稳定规则 preamble：随会话不变，放在稳定可缓存前缀里；不含任何随消息变化的内容。
const RULES_PREAMBLE = [
  '【规则】',
  '你是 Bunny，用户的 AI 伴侣。请自然、体贴、简洁地交流。',
  '下面的「用户记忆」「对话摘要」「领域数据」可能不完整或过时，以用户当前表达为准；不主动暴露这些系统结构。',
].join('\n');

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
  // ---- 长期记忆（现有 memory-service，不重建） ----
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

  // ---- 稳定前缀（个人签名 + session system_prompt + 规则，可缓存） + 动态后缀 ----
  const stableParts = [];
  if (settings.personal_signature) stableParts.push('【关于用户】以下是用户对自己的描述，请记住并在交流中自然体现出对 ta 的了解：\n' + settings.personal_signature);
  if (settings.system_prompt) stableParts.push(settings.system_prompt);
  stableParts.push(RULES_PREAMBLE);
  const stablePrefix = stableParts.join('\n\n');

  const dynamicParts = [];
  if (summaryText) dynamicParts.push('【对话摘要】\n' + summaryText);
  if (memoryText) dynamicParts.push(memoryText);
  if (domainText) dynamicParts.push(domainText);
  if (quotedDynamic && quotedDynamic.content) dynamicParts.push('[用户引用了以下 AI 动态来发起对话，请结合这条动态内容理解用户意图]\n引用动态内容：' + quotedDynamic.content);
  const dynamicSuffix = dynamicParts.join('\n\n');

  const system = [stablePrefix, dynamicSuffix].filter(Boolean).join('\n\n') || undefined;
  // Anthropic 原生协议：稳定前缀块带 cache_control（Prompt Cache）；动态后缀不缓存。
  const systemBlocks = [];
  if (stablePrefix) systemBlocks.push({ type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } });
  if (dynamicSuffix) systemBlocks.push({ type: 'text', text: dynamicSuffix });

  // ---- 消息：Recent Context + Current Message ----
  const { recentMessages, currentMessage } = collectMessages(await listMessages(sessionId, { visibleOnly: true }));
  const messages = currentMessage ? [...recentMessages, currentMessage] : recentMessages;

  // ---- stats（字符估算，不假装精确 tokenizer） ----
  const systemTokens = estimateTokens(system || '');
  const memoryTokens = estimateTokens(memoryText);
  const summaryTokens = estimateTokens(summaryText);
  const domainTokens = estimateTokens(domainText);
  const recentTokens = recentMessages.reduce((s, m) => s + estimateTokens(m.content), 0);
  const currentMessageTokens = currentMessage ? estimateTokens(currentMessage.content) : 0;
  const toolTokens = 0; // 动态工具结果在 chat() 循环按需注入，此处无静态工具结果
  const totalEstimatedTokens = systemTokens + memoryTokens + summaryTokens + domainTokens + recentTokens + currentMessageTokens + toolTokens;
  const costGuardApplied = totalEstimatedTokens > BUDGETS.MAX_CONTEXT_TOKENS;

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
      summaryHit: !!summaryText,
      summaryTriggered: false, // 构建路径只读；真正触发在 maybeSummarize
      costGuardApplied,
    },
  };
}
