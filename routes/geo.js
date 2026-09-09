// 天气 / 定位服务端封装（高德）。
// 这两个接口只代理公开的高德数据，不读用户数据，故不挂 requireAuth —— 与 DB 迁移是否完成无关，
// 只要配了 AMAP_KEY 就能用。
import { Router } from 'express';
import { reverseGeocode, liveWeather, hasAmapKey } from '../lib/amap.js';
import { HttpError, ok } from '../lib/rest.js';

const router = Router();

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

// GET /api/weather?lat=&lng=  →  实时天气（经纬度 → 天气/温度/湿度）
router.get('/weather', async (req, res, next) => {
  try {
    if (!hasAmapKey()) throw new HttpError(503, 'NO_AMAP_KEY', '未配置 AMAP_KEY');
    const { lat, lng } = parseCoords(req.query);
    ok(res, await liveWeather(lat, lng));
  } catch (e) { next(e); }
});

export default router;
