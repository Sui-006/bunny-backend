import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 3001,

  // Supabase 数据库
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',

  // AI 模型 API（OpenAI 兼容协议）
  apiKey: process.env.API_KEY || '',
  apiBaseUrl: process.env.API_BASE_URL || 'https://api.deepseek.com/v1',
  defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat',

  // 无 Key 时的假回复开关
  mock: process.env.MOCK_AI === 'true',
};
