import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 3001,

  // Supabase 数据库
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',

  // 凭据加密密钥（AES-256-GCM）：用于加密 DB 里保存的 API Key，只来自环境变量
  encryptionKey: process.env.ENCRYPTION_KEY || process.env.SECRET_KEY || '',

  // DeepSeek（OpenAI 兼容协议）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || process.env.API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_API_BASE_URL || process.env.API_BASE_URL || 'https://api.deepseek.com/v1',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',

  // Anthropic（Claude）
  // 官方/原生协议走 /v1/messages；很多中转站是 OpenAI 兼容协议（/v1/chat/completions）。
  // 若 Claude 也走 OpenAI 兼容的中转，把 ANTHROPIC_PROTOCOL 设为 openai-compat。
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com',
  anthropicProtocol: process.env.ANTHROPIC_PROTOCOL || 'anthropic', // 'anthropic' | 'openai-compat'

  defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat',

  // 高德地图 Web 服务 Key（逆地理编码 + 实时天气，仅服务端使用，绝不下发前端）
  amapKey: process.env.AMAP_KEY || '',

  // Bark 推送默认地址（网页「主动消息」面板里填的 bark_url 优先；这里作为兜底）。
  // 在 Render 环境变量里配置 BARK_URL = https://api.day.app/{你的 device token}
  barkUrl: process.env.BARK_URL || '',

  // 无 Key 时的假回复开关
  mock: process.env.MOCK_AI === 'true',
};
