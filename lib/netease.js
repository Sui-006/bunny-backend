// 网易云音乐封装（基于 NeteaseCloudMusicApi v4，逆向接口，非官方）。
// 登录 cookie 存内存 + 持久化到 app_settings.netease_cookie（单行全局设置）。
// 匿名可搜索/取基础播放地址；登录后可取更高音质 + 用户歌单。
import Netease from 'NeteaseCloudMusicApi';
import { getAppSettings, saveAppSettings } from './db.js';

let cookie = ''; // 形如 MUSIC_U=xxx; __csrf=xxx; ...
let loaded = false;

// 网易云 song_url 接口按来源 IP 做地域校验：Render（美国）出口会被判 no_source。
// 用户本人就在国内，这里把 X-Real-IP 设为国内 IP，让后端如实反映请求来源（不影响 VIP 版权，VIP 仍需登录）。
// 可用环境变量 NETEASE_REAL_IP 覆盖。
const realIP = process.env.NETEASE_REAL_IP || '223.5.5.5';

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const s = await getAppSettings();
    if (s && s.netease_cookie) cookie = String(s.netease_cookie);
  } catch (e) {
    // 表/列不存在时忽略 —— 匿名状态仍可搜索、取部分播放地址
  }
}

export function getCookie() { return cookie; }

export async function setCookie(c) {
  cookie = c ? String(c) : '';
  loaded = true;
  if (cookie) {
    try { await saveAppSettings({ netease_cookie: cookie }); }
    catch (e) { console.warn('[netease] 持久化 cookie 失败：', e.message); }
  }
}

const withCookie = (q = {}) => (cookie ? { ...q, cookie } : q);

function toSong(s) {
  const artists = s.artists || s.ar || [];
  const album = s.album || s.al || {};
  return {
    id: s.id,
    name: s.name || '',
    artist: artists.map((a) => a.name).join(' / '),
    album: album.name || '',
    cover: (album.picUrl || '').replace(/^http:/, 'https:'),
    duration: Math.round((s.duration || s.dt || 0) / 1000),
  };
}

// 搜索单曲（type=1，cloudsearch 返回带封面 al.picUrl）
export async function search(keywords, limit = 20) {
  await ensureLoaded();
  const r = await Netease.cloudsearch(withCookie({ keywords, type: 1, limit }));
  const songs = (r.body && r.body.result && r.body.result.songs) || [];
  return songs.map(toSong);
}

const LEVEL_BR = { standard: 128000, higher: 192000, exhigh: 320000, lossless: 999000 };

// 取播放地址；无版权/VIP 且未登录时可能返回 null。海外部署需 realIP 伪装国内 IP。
export async function songUrl(id, level = 'exhigh') {
  await ensureLoaded();
  const br = LEVEL_BR[level] || LEVEL_BR.exhigh;
  const q = withCookie({ id: String(id), br });
  if (realIP) q.realIP = realIP;
  const r = await Netease.song_url(q);
  const d = (r.body && r.body.data && r.body.data[0]) || null;
  return (d && d.url) ? { url: d.url, level: d.level, size: d.size, br: d.br } : null;
}

export async function songDetail(ids) {
  await ensureLoaded();
  const r = await Netease.song_detail(withCookie({ ids: ids.join(',') }));
  return ((r.body && r.body.songs) || []).map(toSong);
}

// ---- 扫码登录 ----
export async function loginQrKey() {
  await ensureLoaded();
  const r = await Netease.login_qr_key({});
  return (r.body && r.body.data && r.body.data.unikey) || '';
}

export async function loginQrCreate(key) {
  const r = await Netease.login_qr_create({ key, qrimg: true });
  const d = (r.body && r.body.data) || {};
  return { qrurl: d.qrurl || '', qrimg: d.qrimg || '' };
}

// code: 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 授权成功
export async function loginQrCheck(key) {
  const r = await Netease.login_qr_check({ key });
  const b = r.body || {};
  if (b.code === 803 && b.cookie) await setCookie(b.cookie);
  return { code: b.code, message: b.message || '', nickname: b.nickname || '', avatarUrl: b.avatarUrl || '' };
}

export async function loginStatus() {
  await ensureLoaded();
  if (!cookie) return null;
  const r = await Netease.login_status({ cookie });
  const p = (r.body && r.body.data && r.body.data.profile) || null;
  return p ? { userId: p.userId, nickname: p.nickname, avatarUrl: p.avatarUrl } : null;
}

export async function logout() { await setCookie(''); }

// ---- 用户歌单（需登录） ----
export async function userPlaylists(uid) {
  await ensureLoaded();
  const r = await Netease.user_playlist(withCookie({ uid }));
  return ((r.body && r.body.playlist) || []).map((p) => ({
    id: p.id,
    name: p.name,
    cover: (p.coverImgUrl || '').replace(/^http:/, 'https:'),
    count: p.trackCount,
  }));
}

export async function playlistDetail(id) {
  await ensureLoaded();
  const r = await Netease.playlist_detail(withCookie({ id }));
  const tracks = (r.body && r.body.playlist && r.body.playlist.tracks) || [];
  return tracks.map(toSong);
}
