import { config } from './config.js';
import { getAppSettings } from './db.js';
import { EncryptionService } from './crypto.js';
import { BUDGETS, truncateByTokens } from './context-budget.js';

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

// 对外暴露：模型名 → 厂商（供 usage 归一化标注 provider）
export function providerForModel(model) {
  return resolveProvider(model);
}

// 从用户文档解析「当前助手」的模型：显式覆盖 > 激活助手 > aiSettings > 兜底默认模型。
// 评论/主动行为等一切 AI 行为都从这里取模型，与 Chat 共用同一套「用户当前助手」，绝不各自硬编码厂商。
export function resolveAssistantModel(doc, explicit) {
  const active = ((doc && doc.assistants) || []).find((a) => a && a.id === (doc && doc.activeAssistantId));
  return String(explicit || active?.model || doc?.aiSettings?.model || config.defaultModel || 'deepseek-chat').trim();
}

// 工具调用能力（声明式，供 comment_on_record 等入口判断）：只认工具可用的模型族；
// 未知/自定义模型诚实返回 false，绝不静默当作 DeepSeek 去调、也绝不伪造评论。
export function supportsToolCalling(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return false;
  if (m.startsWith('claude')) return true;                // Anthropic 原生/中转均支持 tool use
  if (/^(gpt|o[0-9]|text-|davinci|chatgpt|ft:)/.test(m)) return true; // OpenAI function calling
  if (m.startsWith('deepseek')) return true;              // DeepSeek function calling
  return false;
}

// 统一各厂商 usage 字段到可观测规范名（仅 token/cache 计数；绝不记录任何内容，也不生成内容 hash）：
//   DeepSeek/OpenAI 兼容: prompt_tokens / completion_tokens / total_tokens
//                         + prompt_cache_hit_tokens、prompt_tokens_details.cached_tokens
//   Anthropic 原生:       input_tokens / output_tokens + cache_read_input_tokens / cache_creation_input_tokens
// 字段存在才输出（provider 没暴露就不猜）；返回对象可直接合并进 contextStats 存储。
export function normalizeProviderUsage(usage, provider, model) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  const pick = (...paths) => {
    for (const p of paths) {
      let v = u;
      for (const k of p.split('.')) v = (v && typeof v === 'object') ? v[k] : undefined;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return undefined;
  };
  const input = pick('input_tokens', 'prompt_tokens');
  const output = pick('output_tokens', 'completion_tokens');
  const total = pick('total_tokens');
  const out = { provider, model };
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (total !== undefined) out.totalTokens = total;
  else if (input !== undefined && output !== undefined) out.totalTokens = input + output;
  const cacheRead = pick('cache_read_input_tokens', 'prompt_tokens_details.cached_tokens', 'prompt_cache_hit_tokens');
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  const cacheCreation = pick('cache_creation_input_tokens');
  if (cacheCreation !== undefined) out.cacheCreationTokens = cacheCreation;
  const cacheHit = pick('cache_hit_tokens'); // 仅当厂商字段就叫 cache_hit_tokens 时存在
  if (cacheHit !== undefined) out.cacheHitTokens = cacheHit;
  return out;
}

// 视觉（多模态图片）支持：Claude / GPT-4o 系 / o 系支持图片；DeepSeek 不支持。
// 不支持的模型收到图片时降级为文字说明，绝不把 image_url 硬塞给不支持的厂商导致 400。
function supportsVision(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('claude')) return true;
  if (/^(gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-5|o1|o3|o4|chatgpt)/.test(m)) return true;
  return false;
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
  const err = new Error(`AI HTTP ${res.status}${detail ? '：' + detail : ''}`);
  err.status = res.status;
  err.retryable = res.status === 429 || res.status >= 500; // 仅限流/5xx 瞬时错误可重试；4xx 校验错不重试
  return err;
}

// 有界重试：仅网络错误 / 429 / 5xx 可重试，最多 retries 次；其余（4xx 校验错、缺 key 等）立即抛。
async function withRetry(fn, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const network = e instanceof TypeError && /fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|socket|abort/i.test(String(e.message || ''));
      if (!(network || (e && e.retryable === true)) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); // 轻量退避
    }
  }
  throw lastErr;
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

// 把内部消息转成 OpenAI 兼容消息（含 tool_calls / tool 角色；含图片多模态）。
// m.images 存在且模型支持视觉时，content 转成 [{type:'text'}, {type:'image_url'}]；
// 不支持视觉时降级为文字说明（DeepSeek 等无图片接口，硬塞会 400）。
function toOpenAIMessage(m, vision = false) {
  const msg = { role: m.role };
  const images = m.images && m.images.length ? m.images : null;
  if (images && vision) {
    const parts = [{ type: 'text', text: m.content ?? '' }];
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img } });
    msg.content = parts;
  } else if (images && !vision) {
    msg.content = (m.content ?? '') + '\n\n[用户发送了 ' + images.length + ' 张图片，但当前模型不支持图片识别，请如实告知用户改用支持视觉的模型]';
  } else {
    msg.content = m.content ?? '';
  }
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

// system 统一归一化：
//  - OpenAI 兼容协议只接受字符串 → 把 Anthropic 块数组压平成文本；
//  - Anthropic 原生协议可接受字符串或块数组（块数组用于 Prompt Cache cache_control）。
function systemToText(system) {
  if (system == null) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (b && b.text) || '').join('\n\n');
  return String(system);
}
function systemToAnthropic(system) {
  if (system == null) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system;
  return String(system);
}

// OpenAI 兼容协议（DeepSeek / OpenAI / 各类中转），支持 function calling
async function chatOpenAICompat({ baseUrl, apiKey, model, messages, system, temperature, maxTokens, tools }) {
  const vision = supportsVision(model);
  const payload = [];
  const systemText = systemToText(system);
  if (systemText) payload.push({ role: 'system', content: systemText });
  payload.push(...messages.map((m) => toOpenAIMessage(m, vision)));

  const body = { model, messages: payload, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
    }));
  }

  const res = await withRetry(async () => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await providerHttpError(r);
    return r;
  });
  const data = await readJsonResponse(res, 'OpenAI', baseUrl);
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: stripInternalXml(msg.content ?? ''),
    reasoningContent: msg.reasoning_content ?? '', // DeepSeek R1 等推理模型的思考过程
    usage: data.usage ?? {},
    toolCalls: (msg.tool_calls || []).map((t) => ({
      id: t.id,
      name: t.function?.name,
      arguments: t.function?.arguments || '{}',
    })),
  };
}

// 剥离可能从模型正文泄漏出来的内部控制 XML（<function_calls>/<invoke>/<thinking>/<parameter> 等）。
// 工具调用一律走原生 tool_use / tool_calls，绝不应以 XML 文本出现在最终回复里；这里做兜底清洗。
export function stripInternalXml(text) {
  const s = String(text ?? '');
  if (!s) return s;
  return s
    .replace(/<\s*(?:antml:)?function_calls\b[^>]*>[\s\S]*?<\s*\/\s*(?:antml:)?function_calls\s*>/gi, '')
    .replace(/<\s*(?:antml:)?(?:invoke|parameter|function_call|tool_call|tool_use)\b[^>]*>[\s\S]*?<\s*\/\s*(?:antml:)?(?:invoke|parameter|function_call|tool_call|tool_use)\s*>/gi, '')
    .replace(/<\s*(?:antml:)?thinking\b[^>]*>[\s\S]*?<\s*\/\s*(?:antml:)?thinking\s*>/gi, '')
    .replace(/<\s*\/?\s*(?:antml:)?(?:function_calls|function_call|invoke|parameter|tool_call|tool_use|thinking)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeJsonParse(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

// 从工具返回文本里提取 code（'CREATED' / 'OK' / 'DENIED' / 'FAILED'…）。
// 供前端只对「真正成功写入」展示系统提示；非 JSON（MCP 工具）返回 undefined，绝不误判成功。
function toolResultCode(resultText) {
  try {
    const parsed = typeof resultText === 'object' ? resultText : JSON.parse(String(resultText));
    return (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') ? parsed.code : undefined;
  } catch { return undefined; }
}

// 单条内部消息 → Anthropic Messages 消息（含 tool_use 块；图片降级为文字说明）。
// 无 tool_use 时保持纯字符串 content，与旧协议行为一致。
export function toAnthropicMessage(m) {
  if (m.toolCalls && m.toolCalls.length) {
    const blocks = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const t of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: (t.input != null ? t.input : safeJsonParse(t.arguments)) });
    }
    return { role: m.role, content: blocks };
  }
  let text = m.content ?? '';
  if (m.images && m.images.length) text += `\n\n[用户发送了 ${m.images.length} 张图片，当前 Anthropic 原生协议未启用图片识别，请提示用户]`;
  return { role: m.role, content: text };
}

// 内部消息列表 → Anthropic 消息列表：把连续的 tool 结果合并进同一条 user 消息。
// Anthropic 要求一个 assistant tool_use 轮次的所有 tool_result 必须在一条 user 消息里返回。
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last._toolResults) last.content.push(block);
      else out.push({ role: 'user', _toolResults: true, content: [block] });
    } else {
      out.push(toAnthropicMessage(m));
    }
  }
  return out.map((m) => { const { _toolResults, ...rest } = m; return rest; });
}

// Anthropic Messages API（原生协议，与 OpenAI 不兼容）。支持原生 tool use：
// 传入 tools 时按 input_schema 下发；返回 tool_use 块解析成 toolCalls 由 chat() 统一循环执行。
// system 可为字符串或块数组；块数组里稳定前缀块带 cache_control:{type:'ephemeral'} 实现 Prompt Cache。
export async function chatAnthropic({ baseUrl, apiKey, model, messages, system, temperature, maxTokens, tools = [] }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(messages),
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }
  const sys = systemToAnthropic(system);
  if (sys) body.system = sys;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await withRetry(async () => {
    const r = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await providerHttpError(r);
    return r;
  });
  const data = await readJsonResponse(res, 'Claude', baseUrl);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const content = blocks.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  // tool_use → 统一 toolCalls；thinking（扩展思考）块绝不进入正文
  const toolCalls = blocks.filter((c) => c.type === 'tool_use').map((c) => ({
    id: c.id,
    name: c.name,
    input: safeJsonParse(c.input),
  }));
  const usage = data.usage
    ? { ...data.usage, total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
    : {};
  return { content: stripInternalXml(content), reasoningContent: '', usage, toolCalls };
}

/**
 * 调用 AI 模型：按模型名自动路由到 DeepSeek / OpenAI / Anthropic。
 * 传入 tools + callTool 时开启 function calling 循环（供 MCP 插件用）。
 */
export async function chat({ model, messages = [], system, systemBlocks = null, temperature = 0.7, maxTokens = 2048, tools = [], callTool = null, onToolEvent = null }) {
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
  const toolEvents = []; // 本次对话实际执行过的工具 + 结果码（供前端展示「写了一条动态/记忆」系统提示，绝不当作聊天气泡）

  for (let turn = 0; turn < 8; turn++) {
    const reply = isNativeAnthropic
      ? await chatAnthropic({ baseUrl, apiKey, model, messages: convo, system: systemBlocks ?? system, temperature, maxTokens, tools: doTools ? tools : [] })
      : await chatOpenAICompat({ baseUrl, apiKey, model, messages: convo, system, temperature, maxTokens, tools: doTools ? tools : [] });
    last = reply;

    if (!doTools || !reply.toolCalls || reply.toolCalls.length === 0) return { ...reply, toolEvents };

    // 执行工具，把结果作为 tool 消息拼回去继续（结果受 TOOL_RESULT_BUDGET 截断，防止超大结果撑爆上下文）
    const toolResults = [];
    for (const tc of reply.toolCalls) {
      let args = {};
      try { args = tc.input != null ? tc.input : JSON.parse(tc.arguments || '{}'); } catch {}
      // 工具开始：立即通知调用方（前端据此尽早显示「正在…」工作状态，绝不等到全部跑完才一次性回传）
      if (onToolEvent) onToolEvent({ type: 'tool_start', name: tc.name });
      let resultText;
      try { resultText = await callTool(tc.name, args); }
      catch (e) { resultText = '工具调用出错：' + e.message; }
      const code = toolResultCode(resultText);
      toolEvents.push({ name: tc.name, code });
      if (onToolEvent) onToolEvent({ type: 'tool_result', name: tc.name, code });
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: truncateByTokens(String(resultText), BUDGETS.TOOL_RESULT_BUDGET, '\n…[工具结果过长已截断]') });
    }
    convo = convo.concat([
      { role: 'assistant', content: reply.content || '', toolCalls: reply.toolCalls },
      ...toolResults,
    ]);
  }
  return { ...(last || { content: '', reasoningContent: '', usage: {} }), toolEvents };
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
  const vision = supportsVision(model);
  const payload = [];
  const systemText = systemToText(system);
  if (systemText) payload.push({ role: 'system', content: systemText });
  payload.push(...messages.map((m) => toOpenAIMessage(m, vision)));

  const res = await withRetry(async () => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: payload, temperature, max_tokens: maxTokens, stream: true }),
    });
    if (!r.ok) throw await providerHttpError(r);
    return r;
  });
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
  return { content: stripInternalXml(content), reasoningContent, usage };
}

/**
 * 流式调用 AI：逐字回调 onDelta；返回最终完整结果。
 * 原生 Anthropic 协议未实现流式，退化为一次性返回。
 */
export async function chatStream({ model, messages = [], system, systemBlocks = null, temperature = 0.7, maxTokens = 2048, onDelta }) {
  if (config.mock) {
    const c = `（MOCK_AI 模式）已收到 ${messages.length} 条消息，未连接真实模型。`;
    onDelta(c);
    return { content: c, reasoningContent: '', usage: {} };
  }

  const provider = resolveProvider(model);
  const { apiKey, baseUrl, protocol } = await resolveProviderConfig(provider);
  if (!apiKey) throw new Error(`缺少 ${provider} 的 API Key，请在网页「API 设置」或环境变量中配置`);

  if (provider === 'anthropic' && protocol !== 'openai-compat') {
    const r = await chatAnthropic({ baseUrl, apiKey, model, messages, system: systemBlocks ?? system, temperature, maxTokens });
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
