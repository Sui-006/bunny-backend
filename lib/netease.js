// 网易云音乐封装（基于 NeteaseCloudMusicApi v4，逆向接口，非官方）。
// 登录 cookie 存内存 + 持久化到 app_settings.netease_cookie（单行全局设置）。
// 匿名可搜索/取基础播放地址；登录后可取更高音质 + 用户歌单。
import Netease from 'NeteaseCloudMusicApi';
import { getAppSettings, saveAppSettings } from './db.js';

let cookie = ''; // 形如 MUSIC_U=xxx; __csrf=xxx; ...
let loaded = false;

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
  return {
    id: s.id,
    name: s.name || '',
    artist: (s.artists || []).map((a) => a.name).join(' / '),
    album: (s.album && s.album.name) || '',
    cover: ((s.album && s.album.picUrl) || '').replace(/^http:/, 'https:'),
    duration: Math.round((s.duration || 0) / 1000),
  };
}

// 搜索单曲（type=1）
export async function search(keywords, limit = 20) {
  await ensureLoaded();
  const r = await Netease.search(withCookie({ keywords, type: 1, limit }));
  const songs = (r.body && r.body.result && r.body.result.songs) || [];
  return songs.map(toSong);
}

const LEVEL_BR = { standard: 128000, higher: 192000, exhigh: 320000, lossless: 999000 };

// 取播放地址；无版权/VIP 且未登录时可能返回 null
export async function songUrl(id, level = 'exhigh') {
  await ensureLoaded();
  const br = LEVEL_BR[level] || LEVEL_BR.exhigh;
  const r = await Netease.song_url(withCookie({ id: String(id), br }));
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
