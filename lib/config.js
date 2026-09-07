import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 3001,

  // Supabase 数据库
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',

  // DeepSeek（OpenAI 兼容协议）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || process.env.API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_API_BASE_URL || process.env.API_BASE_URL || 'https://api.deepseek.com/v1',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',

  // Anthropic（Claude，非 OpenAI 兼容协议）
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com',

  defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat',

  // 无 Key 时的假回复开关
  mock: process.env.MOCK_AI === 'true',
};
