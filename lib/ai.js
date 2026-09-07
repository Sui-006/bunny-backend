import { config } from './config.js';

/**
 * 调用 AI 模型（OpenAI 兼容协议，如 DeepSeek / OpenAI / 各类代理）。
 * @param {object} opts
 * @param {string} opts.model          模型名
 * @param {Array}  opts.messages        [{ role, content }]（不含 system）
 * @param {string} opts.system         system 提示词
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @returns {Promise<{content:string, reasoningContent:string, usage:object}>}
 */
export async function chat({ model, messages = [], system, temperature = 0.7, maxTokens = 2048 }) {
  if (config.mock) {
    return {
      content: `（MOCK_AI 模式）已收到 ${messages.length} 条消息，未连接真实模型。`,
      reasoningContent: '',
      usage: {},
    };
  }
  if (!config.apiKey) throw new Error('缺少 API_KEY，请在环境变量中配置');

  const payload = [];
  if (system) payload.push({ role: 'system', content: system });
  payload.push(...messages.map((m) => ({ role: m.role, content: m.content })));

  const res = await fetch(`${config.apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: payload,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};

  return {
    content: msg.content ?? '',
    reasoningContent: msg.reasoning_content ?? '', // DeepSeek R1 等推理模型的思考过程
    usage: data.usage ?? {},
  };
}

// 把旧对话压缩成摘要（供记忆压缩调用）
export async function summarize({ model, text }) {
  try {
    const { content } = await chat({
      model,
      messages: [{ role: 'user', content: text }],
      system:
        '你是对话摘要助手。请用中文把下面的对话压缩成简洁要点，保留关键信息、已做决定和未完成事项，200 字以内。',
      temperature: 0.3,
      maxTokens: 500,
    });
    return content.trim();
  } catch (e) {
    console.error('[summarize] 失败，本次跳过压缩：', e.message);
    return '';
  }
}
