// 统一通知引擎（NotificationEngine）：所有通知（主动消息 / 回复通知 / 闹钟 / 测试）都从这里走。
// 职责：读取用户 Bark 配置 → 中断策略判断 → Bark Provider 发送 → 返回真实状态。
// 前端只消费结果，绝不直接请求 Bark、绝不持有 Bark key。
//
// 状态枚举（真实状态，禁止假成功）：
//   SUCCESS / FAILED / DENIED / UNSUPPORTED / NOT_CONFIGURED / SKIPPED / TIMEOUT

import { getAppSettings } from './db.js';
import { config } from './config.js';
import { sendBarkRequest } from './bark.js';

export const NOTIFY_STATUS = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  DENIED: 'DENIED',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  SKIPPED: 'SKIPPED',
  TIMEOUT: 'TIMEOUT',
};

// 读取 Bark 地址（单一来源）：Render 环境变量 BARK_URL 优先，app_settings.bark_url 兜底。
// （保持 env 优先，避免数据库里残留的旧短值顶掉环境变量导致 Bark 400。）
export async function resolveBarkUrl() {
  const app = await getAppSettings();
  return config.barkUrl || app?.bark_url || '';
}

// 打码 Bark 地址（只暴露末尾 4 位），用于诊断/前端展示，绝不返回完整 device token。
export function maskBarkUrl(u) {
  if (!u) return '';
  const token = String(u).split('/').filter(Boolean).pop() || '';
  if (!token) return '••••••••';
  if (token.length <= 8) return '••••••••';
  return '••••••••' + token.slice(-4);
}

// 进程内「最近一次发送结果」缓存（供诊断读取；重启即清空，诚实标注不持久化）。
let lastSend = null;

// 统一发送入口。所有通知都必须经过这里，由中断策略（interruptionPolicy）决定是否放行。
// 目前只做「未配置 Bark → NOT_CONFIGURED」这层策略；quiet hours / 提醒策略若日后加入，在此扩展。
export async function sendNotification({
  userId,               // 保留：未来多用户隔离用；当前单用户（隐式 owner）
  title = '',
  body = '',
  source = 'system',
  level = 'normal',     // normal | time_sensitive | alarm
  priority,
  interruptionPolicy,   // 预留：quiet hours / reminder policy 钩子
  conversationId,
  messageId,
  sound, volume, call, group, isArchive, icon,
  barkUrl: _barkUrl,    // 可选：调用方已解析的 barkUrl，避免重复读库
}) {
  const barkUrl = _barkUrl || (await resolveBarkUrl());
  if (!barkUrl) {
    const out = { provider: 'bark', status: NOTIFY_STATUS.NOT_CONFIGURED, source, at: new Date().toISOString() };
    lastSend = { status: out.status, at: out.at, httpStatus: null, errorCode: null };
    return out;
  }
  const r = await sendBarkRequest(barkUrl, { title, body, level, sound, volume, call, group, isArchive, icon });
  const out = { provider: 'bark', status: r.status, source, at: r.at };
  if (r.httpStatus != null) out.httpStatus = r.httpStatus;
  if (r.errorCode) out.errorCode = r.errorCode;
  if (messageId) out.messageId = messageId;
  if (conversationId) out.conversationId = conversationId;
  lastSend = { status: out.status, at: out.at, httpStatus: r.httpStatus ?? null, errorCode: r.errorCode ?? null };
  return out;
}

// 诊断（不含任何敏感信息）：Bark 是否配置、打码地址、最近一次发送结果。
export async function diagnoseNotification() {
  const barkUrl = await resolveBarkUrl();
  return {
    provider: 'bark',
    configured: Boolean(barkUrl),
    barkMasked: maskBarkUrl(barkUrl),
    engine: 'ready',
    lastSend, // null 或 { status, at, httpStatus, errorCode }（进程内，重启清空）
  };
}
