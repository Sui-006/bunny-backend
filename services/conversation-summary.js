// 对话摘要（Conversation Summary）服务：版本化、带边界、增量、失败安全、CAS 乐观并发。
// 与长期记忆（memory-service）严格分离：只写 sessions.summary，绝不调 createMemory/proposeMemory，绝不删消息。
import {
  getConversationSummary,
  saveConversationSummaryIfVersion,
  listMessagesAfter,
  touchSummaryStale,
} from '../lib/db.js';
import { chat } from '../lib/ai.js';
import { estimateTokens } from '../lib/tokens.js';
import { BUDGETS, truncateByTokens } from '../lib/context-budget.js';

const inFlight = new Set(); // in-flight 去重：同一会话并发触发只跑一次
const SUMMARY_INPUT_MAX_CHARS = 40000; // 传给模型的新增对话原文上限，防单次超大调用

const SUMMARY_SYSTEM = '你是对话摘要助手。把给定对话压缩成结构化摘要，只保留事实、决定、状态与待办；绝不编造、绝不写人设或行为指令。用中文，简洁。';

const SECTIONS = ['话题', '重要背景', '已做决定', '当前状态', '待办事项', '对话偏好', '关键实体', '时间线'];

function buildSummaryPrompt(oldSummary, newText) {
  const template = SECTIONS.map((s) => `${s}：`).join('\n');
  const header = oldSummary
    ? `以下是已有对话摘要：\n\n${oldSummary}\n\n请结合下面的新增对话，输出「更新后的完整摘要」（覆盖旧摘要，而不是简单拼接）。\n\n`
    : '请为下面的对话生成结构化摘要。\n\n';
  return header
    + `新增对话：\n${newText}\n\n`
    + `请严格按以下格式输出（每个标题占一行，无内容的行写「无」，不要输出标题之外的任何说明）：\n${template}`;
}

// 实际摘要逻辑（供 maybeSummarize 内部调用 + 测试直接断言）。
// chatFn 仅供测试注入（默认走真实 chat()）；生产调用不传。
export async function doSummarize(sessionId, { model, chatFn } = {}) {
  const old = await getConversationSummary(sessionId);
  const stale = !!(old && old.summary_stale);

  // stale（编辑/删除过消息）→ 边界作废，从头重建；否则增量（从旧边界之后取新消息）
  const boundary = stale ? null : (old?.summarized_until_message_id ?? null);
  const newMessages = await listMessagesAfter(sessionId, boundary);
  if (newMessages.length === 0) return false;

  const newTokens = newMessages.reduce((s, m) => s + estimateTokens(m.content), 0);
  // 触发条件：未摘要内容超 SUMMARY_THRESHOLD 才动手（避免每个回合都打 API）
  if (newTokens <= BUDGETS.SUMMARY_THRESHOLD) return false;

  const text = newMessages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content || ''}`)
    .join('\n\n')
    .slice(0, SUMMARY_INPUT_MAX_CHARS);

  const { content } = await (chatFn || chat)({
    model,
    messages: [{ role: 'user', content: buildSummaryPrompt(stale ? null : (old?.summary ?? null), text) }],
    system: SUMMARY_SYSTEM,
    temperature: 0.3,
    maxTokens: 800,
  });
  const summary = truncateByTokens(String(content || '').trim(), BUDGETS.SUMMARY_BUDGET);
  // 空/畸形摘要（结构化摘要至少 8 个标题行，不可能 < 10 字符）绝不覆盖有效旧摘要
  if (!summary || summary.length < 10) return false;

  const untilId = newMessages[newMessages.length - 1].id;
  const expected = old?.summary_version ?? 0;
  const ok = await saveConversationSummaryIfVersion(sessionId, {
    summary,
    summary_version: expected + 1,
    summarized_until_message_id: untilId,
    summary_stale: false,
    summary_updated_at: new Date().toISOString(),
    summary_token_estimate: estimateTokens(summary),
  }, expected);
  if (!ok) console.warn('[conversation-summary] CAS 失败（摘要已被并发更新），放弃本次写入，绝不倒退 boundary');
  return ok;
}

// 非阻塞触发摘要：in-flight 去重，失败仅告警并保留旧摘要（Recent Context 兜底继续聊天）。
export async function maybeSummarize(sessionId, { userId, settings, model, chatFn }) {
  if (inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);
  try {
    return await doSummarize(sessionId, { model, chatFn });
  } catch (e) {
    console.warn('[conversation-summary] 摘要失败，保留旧摘要 + 完整消息：', e.message);
    return false;
  } finally {
    inFlight.delete(sessionId);
  }
}

// 编辑/删除消息后失效摘要（下次 rebuild；不就地删旧摘要、不删消息）
export async function invalidateSummary(sessionId) {
  return touchSummaryStale(sessionId);
}
