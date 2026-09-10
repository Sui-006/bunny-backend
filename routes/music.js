// 网易云音乐服务端封装。
// 只代理网易云逆向接口 + 存登录 cookie；cookie 永不返回给前端（只回登录状态）。
// 不挂 requireAuth：搜索/取播放地址是公开数据代理；登录态存 app_settings（单行全局）。
import { Router } from 'express';
import {
  search, songUrl, loginQrKey, loginQrCreate, loginQrCheck, loginStatus,
  logout, userPlaylists, playlistDetail, songInfo,
} from '../lib/netease.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

// GET /api/music/search?keywords=&limit=
router.get('/search', async (req, res, next) => {
  try {
    const kw = String(req.query.keywords || '').trim();
    if (!kw) throw new HttpError(400, 'MISSING_KEYWORDS', '缺少 keywords');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    ok(res, await search(kw, limit));
  } catch (e) { next(e); }
});

// GET /api/music/song-url?id=&level=
router.get('/song-url', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new HttpError(400, 'MISSING_ID', '缺少 id');
    const u = await songUrl(id, String(req.query.level || 'exhigh'));
    ok(res, u || { url: null, reason: 'no_source' });
  } catch (e) { next(e); }
});

// GET /api/music/status —— 当前登录态（不含 cookie）
router.get('/status', async (req, res, next) => {
  try { ok(res, await loginStatus()); } catch (e) { next(e); }
});

// GET /api/music/login/qr —— 生成扫码登录二维码（返回 key + base64 图片）
router.get('/login/qr', async (req, res, next) => {
  try {
    const key = await loginQrKey();
    if (!key) throw new HttpError(502, 'QR_KEY_FAILED', '获取登录二维码失败');
    const qr = await loginQrCreate(key);
    ok(res, { key, qrimg: qr.qrimg, qrurl: qr.qrurl });
  } catch (e) { next(e); }
});

// GET /api/music/login/check?key= —— 轮询扫码结果
router.get('/login/check', async (req, res, next) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) throw new HttpError(400, 'MISSING_KEY', '缺少 key');
    ok(res, await loginQrCheck(key));
  } catch (e) { next(e); }
});

// POST /api/music/logout
router.post('/logout', async (req, res, next) => {
  try { await logout(); ok(res, { ok: true }); } catch (e) { next(e); }
});

// GET /api/music/playlists —— 当前登录用户歌单（需登录）
router.get('/playlists', async (req, res, next) => {
  try {
    const st = await loginStatus();
    if (!st) throw new HttpError(401, 'NOT_LOGGED_IN', '未登录网易云');
    ok(res, await userPlaylists(st.userId));
  } catch (e) { next(e); }
});

// GET /api/music/playlist?id= —— 歌单详情（歌曲列表）
router.get('/playlist', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new HttpError(400, 'MISSING_ID', '缺少 id');
    ok(res, await playlistDetail(id));
  } catch (e) { next(e); }
});

// GET /api/music/info?id= —— 歌曲公开信息（详情 + 歌词 + 热门评论），供 AI 读取（需求 18）
router.get('/info', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new HttpError(400, 'MISSING_ID', '缺少 id');
    ok(res, await songInfo(id));
  } catch (e) { next(e); }
});

export default router;
