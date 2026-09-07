import {
  listVisibleMessages,
  listMemories,
  createMemory,
  markMessagesInvisible,
} from './db.js';
import { estimateTokens } from './tokens.js';
import { summarize } from './ai.js';

// 把按时间排序的消息按「一轮 = 用户消息 + 后续助手消息」分组
function groupRounds(messages) {
  const rounds = [];
  for (const m of messages) {
    if (m.role === 'user' || rounds.length === 0) rounds.push([]);
    rounds[rounds.length - 1].push(m);
  }
  return rounds;
}

function buildSystem(settings, memories) {
  const parts = [];
  if (settings.system_prompt) parts.push(settings.system_prompt);
  const memoryText = memories.map((m) => m.summary).filter(Boolean).join('\n\n');
  if (memoryText) parts.push('【历史对话摘要】\n' + memoryText);
  return parts.join('\n\n') || undefined;
}

/**
 * 组装给 AI 的上下文（system + 可见消息），必要时触发记忆压缩。
 * @returns {Promise<{system?:string, messages:Array, compressed:boolean}>}
 */
export async function prepareContext({ sessionId, settings, model }) {
  let messages = await listVisibleMessages(sessionId);
  let memories = await listMemories(sessionId);

  const tokens =
    messages.reduce((s, m) => s + estimateTokens(m.content), 0) +
    memories.reduce((s, m) => s + estimateTokens(m.summary), 0) +
    estimateTokens(settings.system_prompt || '');
  const rounds = groupRounds(messages);

  const overTokens = tokens > settings.compress_threshold;
  const overRounds = rounds.length > settings.max_context_rounds;

  let compressed = false;
  if ((overTokens || overRounds) && rounds.length > settings.compress_keep_rounds) {
    const oldMessages = rounds.slice(0, rounds.length - settings.compress_keep_rounds).flat();
    if (oldMessages.length > 0) {
      const text = oldMessages
        .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
        .join('\n\n');
      const summary = await summarize({ model, text });
      if (summary) {
        await createMemory(sessionId, summary);
        await markMessagesInvisible(oldMessages.map((m) => m.id));
        compressed = true;
      }
    }
  }

  if (compressed) {
    messages = await listVisibleMessages(sessionId);
    memories = await listMemories(sessionId);
  }

  return {
    system: buildSystem(settings, memories),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    compressed,
  };
}
