// 震动玩具远程控制（IJoy / sihande.vip 协议）
// =====================================================================
// 与网页遥控器（type=web）走同一条链路：玩具--蓝牙-->手机 App--互联网-->频道。
// 后端作为「网页遥控器」角色，通过分享链接里的 channelId 加入频道，用
// 二进制 protobuf（game_msg.Msg）发命令。命令编码逐字节对照网页端真实输出核对过。
//
// 本模块只做「短连接发一条命令」：连接 → 握手 → 发命令 → 关闭，不维护常驻连接。
// 因此 Render 免费版休眠后冷启动也能用，也不需要保活。
import WebSocket from 'ws';

const WS_BASE = 'wss://vibrator.api.sihande.vip/channel?type=web&channelId=';

// ---- 命令枚举 + 顶层 oneof payload 字段号（逆向确认） ----
const CMD = {
  GESTURE: 9,
  DEEP_THROAT: 12,
  BURST: 13,
  IMMERSION: 16,
  MOTOR_STRENGTH: 19,
  MOTOR_GESTURE: 20,
  MOTOR_STRENGTH_ARRAY: 21,
};

const PAYLOAD = {
  GESTURE: 18,
  DEEP_THROAT: 22,
  BURST: 23,
  IMMERSION: 25,
  MOTOR_STRENGTH: 28,
  MOTOR_STRENGTH_ARRAY: 29,
  MOTOR_GESTURE: 30,
};

// ---------------------------------------------------------------------------
// 最小 protobuf 编码器（Buffer 版）
// ---------------------------------------------------------------------------
function varint(n) {
  const out = [];
  while (true) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) out.push(b | 0x80);
    else { out.push(b); return Buffer.from(out); }
  }
}

function key(field, wire) { return varint((field << 3) | wire); }
function fVarint(field, val) { return Buffer.concat([key(field, 0), varint(val)]); }
function fBytes(field, data) { return Buffer.concat([key(field, 2), varint(data.length), data]); }
function fFixed32(field, val) { const b = Buffer.alloc(4); b.writeFloatLE(val, 0); return Buffer.concat([key(field, 5), b]); }

// Msg 顶层：field 11 = cmd（枚举），field 12 = action（可选），payload 挂在 oneof 字段。
function msg(cmd, payload, action) {
  const parts = [fVarint(11, cmd)];
  if (action) parts.push(fBytes(12, Buffer.from(action, 'utf8')));
  if (payload) parts.push(fBytes(payload[0], payload[1]));
  return Buffer.concat(parts);
}

function burst(active, ms) { return Buffer.concat([fVarint(1, active ? 1 : 0), fVarint(2, ms)]); }
function deepThroat(active, ms) { return Buffer.concat([fVarint(1, active ? 1 : 0), fVarint(2, ms)]); }
function motorStrength(idx, strength, ms) { return Buffer.concat([fVarint(1, idx), fVarint(2, strength), fVarint(3, ms)]); }
function motorGesture(idx, gestureId, ms) { return Buffer.concat([fVarint(1, idx), fVarint(2, gestureId), fVarint(3, ms)]); }
function gesture(gestureId, ms) { return Buffer.concat([fVarint(1, gestureId), fVarint(2, ms)]); }
function immersion(percentage, enable) { return Buffer.concat([fFixed32(1, percentage), fVarint(2, enable ? 1 : 0)]); }

// strengths = [[idx, strength], ...]，编码为 array 的重复 field 1 子消息 + 末尾 field 2 时长。
function motorArray(strengths, ms) {
  const parts = [];
  for (const s of strengths) {
    const [idx, strength] = Array.isArray(s) ? s : [null, s];
    parts.push(fBytes(1, motorStrength(idx == null ? parts.length : idx, strength, ms)));
  }
  parts.push(fVarint(2, ms));
  return Buffer.concat(parts);
}

// 把 action + 参数编码成一条顶层 Msg（不含 keepalive PING，短连接不需要）。
export function encodeCommand(action, args = {}) {
  const ms = Math.max(0, parseInt(args.durationMs, 10) || 0);
  switch (String(action).toLowerCase()) {
    case 'motor': {
      const idx = Math.max(0, parseInt(args.motorIndex, 10) || 0);
      const strength = Math.max(0, Math.min(100, parseInt(args.strength, 10) || 0));
      return msg(CMD.MOTOR_STRENGTH, [PAYLOAD.MOTOR_STRENGTH, motorStrength(idx, strength, ms)]);
    }
    case 'array': {
      const arr = Array.isArray(args.strengths) ? args.strengths : [];
      const pairs = arr.map((s, i) => [i, Math.max(0, Math.min(100, parseInt(s, 10) || 0))]);
      return msg(CMD.MOTOR_STRENGTH_ARRAY, [PAYLOAD.MOTOR_STRENGTH_ARRAY, motorArray(pairs, ms)]);
    }
    case 'burst':
      return msg(CMD.BURST, [PAYLOAD.BURST, burst(!!args.active, ms)]);
    case 'deep_throat':
      return msg(CMD.DEEP_THROAT, [PAYLOAD.DEEP_THROAT, deepThroat(!!args.active, ms)]);
    case 'immersion':
      return msg(CMD.IMMERSION, [PAYLOAD.IMMERSION, immersion(Math.max(0, Math.min(100, Number(args.percentage) || 0)), !!args.active)]);
    case 'gesture':
      return msg(CMD.GESTURE, [PAYLOAD.GESTURE, gesture(parseInt(args.gestureId, 10) || 0, ms)]);
    case 'motor_gesture':
      return msg(CMD.MOTOR_GESTURE, [PAYLOAD.MOTOR_GESTURE, motorGesture(Math.max(0, parseInt(args.motorIndex, 10) || 0), parseInt(args.gestureId, 10) || 0, ms)]);
    case 'stop':
      return msg(CMD.BURST, [PAYLOAD.BURST, burst(false, 0)]);
    default:
      throw new Error('未知的玩具指令：' + action);
  }
}

// 从消息文本里抽取分享链接里的 channelId（形如 ws0hlva1rm8dli1xypi879f7.1006522611）。
// 允许字母数字 + 点/下划线/连字符，遇到 & 或空白即止。
export function extractChannelId(text) {
  const m = String(text || '').match(/channelId=([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

// 发一条命令：短连接（连 → 等首帧确认 → 发 → 短停 → 关）。
// 严格对齐 Python 版（vibrator_control.py）：必须先收到服务器首帧（channel add 确认）
// 才发命令——收不到首帧说明频道连不上 / channelId 失效，绝不硬发；发送后保持连接
// 1.5s 再关，确保服务器把命令转发给手机 App。
// channelId 为空 → 抛 NOT_CONFIGURED；网络/超时/频道失效 → 抛带中文说明的 Error。
export function sendToyCommand(channelId, action, args = {}) {
  if (!channelId) return Promise.reject(new Error('尚未绑定玩具频道（NOT_CONFIGURED）'));
  let frame;
  try { frame = encodeCommand(action, args); } catch (e) { return Promise.reject(e); }

  const ws = new WebSocket(WS_BASE + encodeURIComponent(channelId));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    const timers = [];

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try { ws.terminate(); } catch {}
      fn(val);
    };
    const fail = (m) => settle(reject, new Error(m));
    const ok = (val) => settle(resolve, val);

    const sendNow = () => {
      if (sent || settled) return;
      sent = true;
      try { ws.send(frame); } catch (e) { return fail('发送玩具指令失败：' + e.message); }
      // 帧已入队，保持连接 1.5s 确保服务器收到并转发，再关闭。
      timers.push(setTimeout(() => ok({ ok: true, action }), 1500));
    };

    // 6s 内收不到服务器首帧（channel add 确认）→ 频道连不上 / channelId 失效。
    timers.push(setTimeout(() => fail('连接玩具频道超时（未收到频道确认，可能 channelId 已失效或手机 App 未在线）'), 6000));

    ws.on('message', () => sendNow());
    ws.on('error', (e) => fail('玩具频道连接失败：' + ((e && e.message) || e)));
    // 尚未发送成功就被关闭 → 失败，绝不误报成功。
    ws.on('close', () => { if (!settled && !sent) fail('玩具频道连接被关闭（channelId 可能已失效）'); });
  });
}
