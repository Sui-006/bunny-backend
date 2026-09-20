// 当前时间（供 AI get_current_time 工具 + 统一 AI 自我上下文 + 主动消息）。
// 使用服务器时间 + Asia/Shanghai（UTC+8，无夏令时），与 routes/proactive.js 既有 shanghaiNow 机制一致。
// 当前无用户级时区配置，统一 Asia/Shanghai，避免 AI 猜时间 / 写死旧时间。
const TZ = 'Asia/Shanghai';
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const INTENSITY_LABELS = ['一点点', '有一点', '轻微', '明显', '很强', '非常强'];

const pad = (n) => String(n).padStart(2, '0');

// 返回一个「上海墙钟」Date 对象：其本地 getter（getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds/getDay）
// 读出来即上海时间（机器时区无关）。这是全项目唯一的一处 +8h 时区偏移实现，proactive/notifications 调度也复用这里。
// 注意：该 Date 的 getTime() 是平移后的值、不是真实 instant，只应通过本地 getter 读取，勿把它当 UTC 时刻用。
export function shanghaiNow(base = new Date()) {
  const offset = base.getTimezoneOffset() * 60000;
  return new Date(base.getTime() + offset + 8 * 3600000);
}

export function currentTimeInfo(now = new Date()) {
  const local = shanghaiNow(now);
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

// 「今天」日期串（上海墙钟）—— 后端唯一 todayStr 实现。
// finance / menstrual / domain / tasks / health / statistics / habits 以及 AI 工具一律从这里取，
// 与 currentTimeInfo 同源，杜绝「服务器本地时区(UTC)比上海晚 8 小时、今天返回昨天」的问题。
export function todayStr(now = new Date()) {
  return currentTimeInfo(now).localDate;
}

// 一句话「现在时间」描述，供无工具的 AI 入口（解析/评论/通知创作等）直接拼进 system，
// 确保这些入口的 AI 也能读到真实时间，绝不猜日期/时间。与 get_current_time 工具、buildAISelfContext 同源（currentTimeInfo）。
export function nowSystemLine() {
  const t = currentTimeInfo();
  return `【当前时间】现在是 ${t.localDate} ${t.localTime}（${t.weekday}，${t.timezone}）。不知道「今天几号/现在几点/星期几」时以此为准，绝不猜。`;
}

// AI 心情强度（0-5）→ 中文档位（与前端 AI_INTENSITY 一致）
export function intensityLabel(n) {
  const i = Math.max(0, Math.min(INTENSITY_LABELS.length - 1, Math.round(Number(n) || 0)));
  return INTENSITY_LABELS[i];
}
