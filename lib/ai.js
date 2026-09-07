import { config } from './config.js';

/**
 * 根据模型名判断所属厂商：
 *   claude-*                  → Anthropic
 *   gpt-* / o1 / o3 / o4 等   → OpenAI
 *   其余（deepseek-* 等）      → DeepSeek
 */
function resolveProvider(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o[0-9]|text-|davinci|chatgpt|ft:)/.test(m)) return 'openai';
  return 'deepseek';
}

// OpenAI 兼容协议（DeepSeek / OpenAI / 各类中转）
async function chatOpenAICompat({ baseUrl, apiKey, model, messages, system, temperature, maxTokens }) {
  const payload = [];
  if (system) payload.push({ role: 'system', content: system });
  payload.push(...messages.map((m) => ({ role: m.role, content: m.content })));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

// Anthropic Messages API（协议与 OpenAI 不兼容）
async function chatAnthropic({ baseUrl, apiKey, model, messages, system, temperature, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content })),
  };
  if (system) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = Array.isArray(data.content)
    ? data.content.map((c) => c.text ?? '').join('')
    : (data.content ?? '');
  const usage = data.usage
    ? { ...data.usage, total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
    : {};
  return { content, reasoningContent: '', usage };
}

/**
 * 调用 AI 模型：按模型名自动路由到 DeepSeek / OpenAI / Anthropic。
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

  const provider = resolveProvider(model);
  let apiKey, baseUrl;

  if (provider === 'anthropic') {
    apiKey = config.anthropicApiKey;
    baseUrl = config.anthropicBaseUrl;
  } else if (provider === 'openai') {
    apiKey = config.openaiApiKey;
    baseUrl = config.openaiBaseUrl;
  } else {
    apiKey = config.deepseekApiKey;
    baseUrl = config.deepseekBaseUrl;
  }

  if (!apiKey) throw new Error(`缺少 ${provider} 的 API Key，请在环境变量中配置`);

  if (provider === 'anthropic') {
    return chatAnthropic({ baseUrl, apiKey, model, messages, system, temperature, maxTokens });
  }
  return chatOpenAICompat({ baseUrl, apiKey, model, messages, system, temperature, maxTokens });
}

// 把旧对话压缩成摘要（供记忆压缩调用）
export async function summarize({ model, text }) {
  try {
    const { content } = await chat({
      model,
      messages: [{ role: 'user', content: text }],
      system: '你是对话摘要助手。请用中文把下面的对话压缩成简洁要点，保留关键信息、已做决定和未完成事项，200 字以内。',
      temperature: 0.3,
      maxTokens: 500,
    });
    return content.trim();
  } catch (e) {
    console.error('[summarize] 失败，本次跳过压缩：', e.message);
    return '';
  }
}
