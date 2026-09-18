// 对话缓存（Conversation Cache）服务：保存「当前/近期这段对话聊了什么、正在进行什么」。
// 与长期记忆（memory-service）严格分离：只写 sessions 的 cache_* / summary 列，绝不写 user_state、绝不写 memories 表。
// 与 Raw Conversation（messages 表）分离：缓存是 context 的压缩表示，绝不删除原始历史。
// 复用 012 的 summary（=summary）与 summarized_until_message_id（=coveredMessageId）与 summary_version（CAS）。
import { getConversationSummary, saveConversationCacheIfVersion } from '../lib/db.js';

const normArr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== '') : []);
const normStr = (v) => (v == null ? null : String(v).trim() || null);

// 会话行 → 结构化缓存对象（至少含 instruction 要求的字段）。
export function normalizeCache(row, conversationId) {
  return {
    conversationId,
    summary: row?.summary ?? null,
    keyPoints: normArr(row?.cache_key_points),
    currentTopic: normStr(row?.cache_current_topic),
    recentDecisions: normArr(row?.cache_recent_decisions),
    openItems: normArr(row?.cache_open_items),
    lastMessageAt: row?.cache_last_message_at ?? null,
    coveredMessageId: row?.summarized_until_message_id ?? null,
    updatedAt: row?.cache_updated_at ?? null,
  };
}

export async function getConversationCache(sessionId) {
  const row = await getConversationSummary(sessionId);
  return normalizeCache(row, sessionId);
}

// 把缓存渲染成一段 context 文本（供 buildAIContext 注入，位于长期记忆之后、最近原文之前）。
// 只渲染结构化字段（summary 由 context-builder 单独注入），避免与摘要重复。
export function buildCacheContextText(cache) {
  const lines = [];
  if (cache.currentTopic) lines.push('当前主题：' + cache.currentTopic);
  if (cache.keyPoints.length) lines.push('对话要点：' + cache.keyPoints.join('；'));
  if (cache.recentDecisions.length) lines.push('近期已做决定：' + cache.recentDecisions.join('；'));
  if (cache.openItems.length) lines.push('待办/未完成：' + cache.openItems.join('；'));
  if (!lines.length) return '';
  return '【对话缓存（这段对话最近聊了什么、正在做什么）】\n' + lines.join('\n');
}

// 从工具参数抽结构化字段；full=true 时未提供的字段也显式置空（save=整体覆盖），否则只覆盖提供的字段（update=增量合并）。
function fieldsFromArgs(args, { full }) {
  const f = {};
  if (args.summary != null) f.summary = normStr(args.summary);
  if (args.keyPoints != null || full) f.cache_key_points = normArr(args.keyPoints);
  if (args.currentTopic != null || full) f.cache_current_topic = normStr(args.currentTopic);
  if (args.recentDecisions != null || full) f.cache_recent_decisions = normArr(args.recentDecisions);
  if (args.openItems != null || full) f.cache_open_items = normArr(args.openItems);
  if (args.coveredMessageId != null || full) f.summarized_until_message_id = args.coveredMessageId != null ? String(args.coveredMessageId) : null;
  return f;
}

async function writeCache(sessionId, args, { full }) {
  const row = await getConversationSummary(sessionId);
  const expected = row?.summary_version ?? 0;
  const patch = {
    ...fieldsFromArgs(args, { full }),
    summary_version: expected + 1,
    cache_updated_at: new Date().toISOString(),
    cache_last_message_at: new Date().toISOString(),
  };
  const ok = await saveConversationCacheIfVersion(sessionId, patch, expected);
  if (!ok) return null; // CAS 失败：版本被并发修改，调用方放弃，绝不倒退
  return normalizeCache({ ...(row || {}), ...patch }, sessionId);
}

// 整体建立/覆盖缓存（未提供的结构化字段置空）。
export async function saveConversationCache(sessionId, args) {
  return writeCache(sessionId, args, { full: true });
}

// 增量更新缓存（只覆盖提供的字段，其余保留）。
export async function updateConversationCache(sessionId, args) {
  return writeCache(sessionId, args, { full: false });
}
