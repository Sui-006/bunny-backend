import { config } from './config.js';
import { getAppSettings } from './db.js';
import { EncryptionService } from './crypto.js';

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

// 读取某厂商的 key/baseUrl/protocol：优先网页配置（Supabase app_settings，解密），回退环境变量
async function resolveProviderConfig(provider) {
  const app = await getAppSettings();
  if (provider === 'anthropic') {
    return {
      apiKey: EncryptionService.decrypt(app?.anthropic_api_key) || config.anthropicApiKey,
      baseUrl: app?.anthropic_base_url || config.anthropicBaseUrl,
      protocol: app?.anthropic_protocol || config.anthropicProtocol,
    };
  }
  if (provider === 'openai') {
    return {
      apiKey: EncryptionService.decrypt(app?.openai_api_key) || config.openaiApiKey,
      baseUrl: app?.openai_base_url || config.openaiBaseUrl,
    };
  }
  return {
    apiKey: EncryptionService.decrypt(app?.deepseek_api_key) || config.deepseekApiKey,
    baseUrl: app?.deepseek_base_url || config.deepseekBaseUrl,
  };
}

// 把厂商错误响应转成不含 secret 的错误对象
async function providerHttpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    detail = String(text || '')
      .replace(/<[^>]+>/g, ' ')          // 剥离 HTML 标签，避免把 <!DOCTYPE ...> 透传给前端
      .replace(/\s+/g, ' ')
      .replace(/(sk-[A-Za-z0-9_-]{4,})/gi, '***')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .replace(/(x-api-key[=:]\s*)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .trim()
      .slice(0, 200);
  } catch {}
  return new Error(`AI HTTP ${res.status}${detail ? '：' + detail : ''}`);
}

// 解析厂商响应体：若 content-type 非 JSON 或 JSON.parse 失败，给出可操作的清晰错误，
// 绝不把底层 "Unexpected token '<'" 之类原始异常透传给前端（根因：中转地址返回 HTML）。
async function readJsonResponse(res, provider, baseUrl) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('json')) {
    let preview = '';
    try { preview = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); } catch {}
    throw new Error(`AI 服务返回了非 JSON 响应（content-type: ${ct || '无'}）${preview ? '：' + preview : ''}。请检查「API 设置」里 ${provider} 的中转地址是否正确（当前：${baseUrl}）。`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`AI 服务返回了无法解析的 JSON，请检查 ${provider} 的中转地址（当前：${baseUrl}）与 Key 是否匹配。`);
  }
}

// 把内部消息转成 OpenAI 兼容消息（含 tool_calls / tool 角色）
function toOpenAIMessage(m) {
  const msg = { role: m.role, content: m.content ?? '' };
  if (m.role === 'tool' && m.tool_call_id) msg.tool_call_id = m.tool_call_id;
  if (m.toolCalls && m.toolCalls.length) {
    msg.tool_calls = m.toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.arguments || '{}' },
    }));
  }
  return msg;
}

// OpenAI 兼容协议（DeepSeek / OpenAI / 各类中转），支持 function calling
async function chatOpenAICompat({ baseUrl, apiKey, model, messages, system, temperature, maxTokens, tools }) {
  const payload = [];
  if (system) payload.push({ role: 'system', content: system });
  payload.push(...messages.map(toOpenAIMessage));

  const body = { model, messages: payload, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
    }));
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await providerHttpError(res);
  const data = await readJsonResponse(res, 'OpenAI', baseUrl);
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    reasoningContent: msg.reasoning_content ?? '', // DeepSeek R1 等推理模型的思考过程
    usage: data.usage ?? {},
    toolCalls: (msg.tool_calls || []).map((t) => ({
      id: t.id,
      name: t.function?.name,
      arguments: t.function?.arguments || '{}',
    })),
  };
}

// Anthropic Messages API（协议与 OpenAI 不兼容；暂不支持工具）
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

  if (!res.ok) throw await providerHttpError(res);
  const data = await readJsonResponse(res, 'Claude', baseUrl);
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
 * 传入 tools + callTool 时开启 function calling 循环（供 MCP 插件用）。
 */
export async function chat({ model, messages = [], system, temperature = 0.7, maxTokens = 2048, tools = [], callTool = null }) {
  if (config.mock) {
    return {
      content: `（MOCK_AI 模式）已收到 ${messages.length} 条消息，未连接真实模型。`,
      reasoningContent: '',
      usage: {},
    };
  }

  const provider = resolveProvider(model);
  const { apiKey, baseUrl, protocol } = await resolveProviderConfig(provider);
  if (!apiKey) throw new Error(`缺少 ${provider} 的 API Key，请在网页「API 设置」或环境变量中配置`);

  const doTools = tools.length > 0 && typeof callTool === 'function';
  const isNativeAnthropic = provider === 'anthropic' && protocol !== 'openai-compat';

  let convo = [...messages];
  let last = null;

  for (let turn = 0; turn < 8; turn++) {
    if (isNativeAnthropic) {
      return chatAnthropic({ baseUrl, apiKey, model, messages: convo, system, temperature, maxTokens });
    }
    const reply = await chatOpenAICompat({
      baseUrl, apiKey, model, messages: convo, system, temperature, maxTokens,
      tools: doTools ? tools : [],
    });
    last = reply;

    if (!doTools || !reply.toolCalls || reply.toolCalls.length === 0) return reply;

    // 执行工具，把结果作为 tool 消息拼回去继续
    const toolResults = [];
    for (const tc of reply.toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch {}
      let resultText;
      try { resultText = await callTool(tc.name, args); }
      catch (e) { resultText = '工具调用出错：' + e.message; }
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: String(resultText) });
    }
    convo = convo.concat([
      { role: 'assistant', content: reply.content || '', toolCalls: reply.toolCalls },
      ...toolResults,
    ]);
  }
  return last || { content: '', reasoningContent: '', usage: {} };
}

// 逐行读取 SSE 流
async function* readSSELines(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

async function chatOpenAICompatStream({ baseUrl, apiKey, model, messages, system, temperature, maxTokens, onDelta }) {
  const payload = [];
  if (system) payload.push({ role: 'system', content: system });
  payload.push(...messages.map(toOpenAIMessage));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: payload, temperature, max_tokens: maxTokens, stream: true }),
  });
  if (!res.ok) throw await providerHttpError(res);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/event-stream')) {
    // 中转地址配错时可能返回 HTML / JSON 而非 SSE 流；给出清晰报错而不是静默空回复。
    let preview = '';
    try { preview = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); } catch {}
    throw new Error(`AI 流式响应异常（content-type: ${ct || '无'}）${preview ? '：' + preview : ''}。请检查「API 设置」里 OpenAI 的中转地址是否正确（当前：${baseUrl}）。`);
  }

  let content = '';
  let reasoningContent = '';
  let usage = {};
  for await (const line of readSSELines(res)) {
    if (!line || line === '[DONE]') continue;
    let json;
    try { json = JSON.parse(line); } catch { continue; }
    const delta = json.choices?.[0]?.delta ?? {};
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
    if (json.usage) usage = json.usage;
  }
  return { content, reasoningContent, usage };
}

/**
 * 流式调用 AI：逐字回调 onDelta；返回最终完整结果。
 * 原生 Anthropic 协议未实现流式，退化为一次性返回。
 */
export async function chatStream({ model, messages = [], system, temperature = 0.7, maxTokens = 2048, onDelta }) {
  if (config.mock) {
    const c = `（MOCK_AI 模式）已收到 ${messages.length} 条消息，未连接真实模型。`;
    onDelta(c);
    return { content: c, reasoningContent: '', usage: {} };
  }

  const provider = resolveProvider(model);
  const { apiKey, baseUrl, protocol } = await resolveProviderConfig(provider);
  if (!apiKey) throw new Error(`缺少 ${provider} 的 API Key，请在网页「API 设置」或环境变量中配置`);

  if (provider === 'anthropic' && protocol !== 'openai-compat') {
    const r = await chatAnthropic({ baseUrl, apiKey, model, messages, system, temperature, maxTokens });
    if (r.content) onDelta(r.content);
    return r;
  }
  return chatOpenAICompatStream({ baseUrl, apiKey, model, messages, system, temperature, maxTokens, onDelta });
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
