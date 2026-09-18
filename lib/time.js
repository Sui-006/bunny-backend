// 当前时间（供 AI get_current_time 工具 + 统一 AI 自我上下文 + 主动消息）。
// 使用服务器时间 + Asia/Shanghai（UTC+8，无夏令时），与 routes/proactive.js 既有 shanghaiNow 机制一致。
// 当前无用户级时区配置，统一 Asia/Shanghai，避免 AI 猜时间 / 写死旧时间。
const TZ = 'Asia/Shanghai';
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const INTENSITY_LABELS = ['一点点', '有一点', '轻微', '明显', '很强', '非常强'];

const pad = (n) => String(n).padStart(2, '0');

export function currentTimeInfo(now = new Date()) {
  // 把 Date 偏移到「上海墙钟时间」，再用本地 getter 读取（与 routes/proactive.js 的 shanghaiNow 同法，机器时区无关）。
  const offset = now.getTimezoneOffset() * 60000;
  const local = new Date(now.getTime() + offset + 8 * 3600000);
  const localDate = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  const localTime = `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
  const weekday = WEEKDAYS[local.getDay()];
  return {
    currentTime: now.toISOString(),
    timezone: TZ,
    localDate,
    localTime,
    weekday,
    isWeekend: local.getDay() === 0 || local.getDay() === 6,
  };
}

// AI 心情强度（0-5）→ 中文档位（与前端 AI_INTENSITY 一致）
export function intensityLabel(n) {
  const i = Math.max(0, Math.min(INTENSITY_LABELS.length - 1, Math.round(Number(n) || 0)));
  return INTENSITY_LABELS[i];
}
