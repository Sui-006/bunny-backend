// 健康检查（只读、无副作用）：仅报告 HTTP 服务是否存活，供外部 keep-alive 定时探测。
// 关键约束（与保活机制配套，务必保持）：
//   - 绝不访问 AI / Claude
//   - 绝不访问 Bark / NotificationEngine
//   - 绝不写 Activity / Memory / Audit / 用户数据
//   - 不消耗任何 AI Token
//   - 不需要登录（公开 read-only）
//   - 不暴露任何密钥 / 数据库连接串 / Bark Token
//   - 不做昂贵数据库查询（hasDb() 只是「是否配置了 Supabase」的纯布尔判断，不触发任何网络请求）
import { hasDb } from './store.js';

// 纯函数：生成健康检查响应体。抽出来方便单测断言「字段固定、不泄露密钥」。
export function healthPayload() {
  return {
    ok: true,
    service: 'bunny-backend',
    status: 'healthy',
    database: hasDb() ? 'connected' : 'memory',
  };
}

// Express handler：GET /health → 200 + 固定 JSON。
export function healthHandler(req, res) {
  res.status(200).json(healthPayload());
}
