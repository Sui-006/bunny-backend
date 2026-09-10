// 天气 / 定位服务端封装（高德）。
// 这两个接口只代理公开的高德数据，不读用户数据，故不挂 requireAuth —— 与 DB 迁移是否完成无关，
// 只要配了 AMAP_KEY 就能用。
import { Router } from 'express';
import { reverseGeocode, liveWeather, ipLocation, hasAmapKey } from '../lib/amap.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

// 取客户端真实 IP：优先 x-forwarded-for 首项（Render 等反向代理会带上），回退 socket 地址。
// 只放行合法 IPv4/IPv6，避免把非法值传给高德。
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  if (!ip) ip = (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '';
  if (ip && !/^[0-9a-fA-F:.]+$/.test(ip)) ip = '';
  return ip.replace(/^::ffff:/, '');
}

function parseCoords(query) {
  const lat = Number(query?.lat);
  const lng = Number(query?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, 'INVALID_COORDS', '需要有效的 lat/lng 参数');
  }
  return { lat, lng };
}

// GET /api/geocode?lat=&lng=  →  逆地理编码（经纬度 → 城市）
router.get('/geocode', async (req, res, next) => {
  try {
    if (!hasAmapKey()) throw new HttpError(503, 'NO_AMAP_KEY', '未配置 AMAP_KEY');
    const { lat, lng } = parseCoords(req.query);
    ok(res, await reverseGeocode(lat, lng));
  } catch (e) { next(e); }
});

// GET /api/ip-location → 按客户端 IP 粗略定位（城市级；浏览器 GPS 失败时的兜底）
router.get('/ip-location', async (req, res, next) => {
  try {
    if (!hasAmapKey()) throw new HttpError(503, 'NO_AMAP_KEY', '未配置 AMAP_KEY');
    ok(res, await ipLocation(clientIp(req)));
  } catch (e) { next(e); }
});

// GET /api/weather?lat=&lng=  →  实时天气（经纬度 → 天气/温度/湿度）
router.get('/weather', async (req, res, next) => {
  try {
    if (!hasAmapKey()) throw new HttpError(503, 'NO_AMAP_KEY', '未配置 AMAP_KEY');
    const { lat, lng } = parseCoords(req.query);
    ok(res, await liveWeather(lat, lng));
  } catch (e) { next(e); }
});

export default router;
