// 网易云音乐服务端封装。
// 只代理网易云逆向接口 + 存登录 cookie；cookie 永不返回给前端（只回登录状态）。
// 不挂 requireAuth：搜索/取播放地址是公开数据代理；登录态存 app_settings（单行全局）。
import { Router } from 'express';
import {
  search, songUrl, loginQrKey, loginQrCreate, loginQrCheck, authState, authErrorOf,
  logout, userPlaylists, playlistDetail, songInfo,
} from '../lib/netease.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

// 需要网易云用户身份的接口统一在此校验，把「未登录 / 已失效 / 接口错误」转成结构化错误。
function requireNeteaseAuth(st) {
  const err = authErrorOf(st);
  if (!err) return st;
  const status = err.code === 'NETEASE_NETWORK_ERROR' ? 502 : 401;
  throw new HttpError(status, err.code, err.message);
}

// GET /api/music/search?keywords=&limit=
router.get('/search', async (req, res, next) => {
  try {
    const kw = String(req.query.keywords || '').trim();
    if (!kw) throw new HttpError(400, 'MISSING_KEYWORDS', '缺少 keywords');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    ok(res, await search(kw, limit));
  } catch (e) { next(e); }
});

// GET /api/music/song-url?id=&level= —— 取真实播放地址；无版权/VIP/失败返回结构化错误
router.get('/song-url', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new HttpError(400, 'MISSING_ID', '缺少 id');
    const u = await songUrl(id, String(req.query.level || 'exhigh'));
    if (!u.ok) {
      const status = u.code === 'SONG_NOT_PLAYABLE' ? 403 : 502;
      throw new HttpError(status, u.code, u.message || '获取播放地址失败');
    }
    ok(res, u);
  } catch (e) { next(e); }
});

// GET /api/music/status —— 当前登录态（不含 cookie），区分未登录/已登录/已失效/接口错误
router.get('/status', async (req, res, next) => {
  try { ok(res, await authState()); } catch (e) { next(e); }
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

// GET /api/music/playlists —— 当前登录用户歌单（需登录；登录失效绝不返回空歌单）
router.get('/playlists', async (req, res, next) => {
  try {
    const st = requireNeteaseAuth(await authState());
    ok(res, await userPlaylists(st.userId));
  } catch (e) { next(e); }
});

// GET /api/music/playlist?id= —— 歌单详情（歌曲列表）。
// 曾登录但已失效时直接返回 NETEASE_AUTH_EXPIRED：失效 cookie 会导致私有歌单静默返回空，绝不能让前端把队列替换成空。
router.get('/playlist', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) throw new HttpError(400, 'MISSING_ID', '缺少 id');
    const st = await authState();
    if (st.status === 'expired') throw new HttpError(401, 'NETEASE_AUTH_EXPIRED', '网易云音乐登录已失效，请重新登录');
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
