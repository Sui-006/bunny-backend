// 统一上下文预算（token 估算）。复用 lib/tokens.js 的字符估算，不假装精确 tokenizer。
// 预算默认值对齐旧 compress_threshold=60000；可用环境变量覆盖（见 lib/config.js）。
import { estimateTokens } from './tokens.js';
import { config } from './config.js';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export const BUDGETS = {
  MAX_CONTEXT_TOKENS: num(config.contextMaxTokens, 60000),           // 总预算硬上限
  SYSTEM_BUDGET: num(config.contextSystemBudget, 4000),              // system（稳定前缀）
  MEMORY_BUDGET: num(config.contextMemoryBudget, 4000),              // 长期记忆注入
  SUMMARY_BUDGET: num(config.contextSummaryBudget, 2500),            // 对话摘要注入
  DOMAIN_BUDGET: num(config.contextDomainBudget, 2000),              // 领域上下文（Cost Guard 裁剪用）
  RECENT_CONTEXT_BUDGET: num(config.contextRecentBudget, 12000),     // 最近原文
  CURRENT_MESSAGE_BUDGET: num(config.contextCurrentMessageBudget, 8000), // 当前单条消息上限
  TOOL_RESULT_BUDGET: num(config.contextToolResultBudget, 6000),     // 动态工具结果上限
  SUMMARY_THRESHOLD: num(config.summaryThreshold, 12000),            // 未摘要内容超此 token 才触发摘要
};

export { estimateTokens };

// 把文本按 token 预算截断（保留开头，末尾追加提示；绝不动数据库原文）
export function truncateByTokens(text, maxTokens, note = '\n…（内容过长已截断）') {
  const s = String(text ?? '');
  if (!s) return s;
  if (estimateTokens(s) <= maxTokens) return s;
  // 二分找最大可保留前缀（estimateTokens 对长度单调不减）
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + note;
}
