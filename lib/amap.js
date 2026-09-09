// 高德地图 Web 服务封装：逆地理编码 + 实时天气。
// Key 从环境变量 AMAP_KEY 读取（仅服务端使用，绝不下发到前端）。
// 前端只拿「结果」，不接触 Key，避免在浏览器暴露密钥。
import { config } from './config.js';

const key = () => config.amapKey || process.env.AMAP_KEY || '';

export function hasAmapKey() {
  return !!key();
}

// 高德返回的中文天气描述 → 前端 code 枚举（sunny/cloudy/rain/overcast）
// 前端图标映射：sunny ☀️ / cloudy ⛅ / rain 🌧 / overcast ☁️；rain 会触发「带伞」提醒。
function toCode(text) {
  const t = text || '';
  if (/晴|少云/.test(t)) return 'sunny';
  if (/多云/.test(t)) return 'cloudy';
  if (/雨|雪|雹|冰|雷/.test(t)) return 'rain';
  if (/阴|雾|霾|尘|沙|浮/.test(t)) return 'overcast';
  return 'cloudy';
}

// 逆地理编码：lat/lng → 省/市/区/地址
export async function reverseGeocode(lat, lng) {
  const k = key();
  if (!k) throw new Error('未配置 AMAP_KEY');
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${k}&location=${lng},${lat}&extensions=base`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (j.status !== '1' || !j.regeocode) throw new Error('高德逆地理编码失败: ' + (j.info || 'unknown'));
  const ac = j.regeocode.addressComponent || {};
  // 直辖市（北京/上海/天津/重庆）的 addressComponent.city 是空数组 []，城市名在 province 里；
  // 普通地级市 city 是字符串。这里统一：数组取首项，空则回退 province。
  const city = Array.isArray(ac.city) ? (ac.city[0] || '') : (ac.city || '');
  return {
    city: city || ac.province || '',
    province: ac.province || '',
    district: ac.district || '',
    adcode: ac.adcode || '',
    formattedAddress: j.regeocode.formatted_address || '',
  };
}

// 实时天气：lat/lng → 天气描述/温度/湿度/风向
// 天气接口官方按 city(adcode) 查询最稳；这里先逆地理拿 adcode，再按 adcode 查天气。
export async function liveWeather(lat, lng) {
  const k = key();
  if (!k) throw new Error('未配置 AMAP_KEY');
  let adcode = '';
  try { adcode = (await reverseGeocode(lat, lng)).adcode || ''; } catch (e) { /* 拿不到 adcode 就退回 location 方式 */ }
  const url = adcode
    ? `https://restapi.amap.com/v3/weather/weatherInfo?key=${k}&city=${adcode}&extensions=base`
    : `https://restapi.amap.com/v3/weather/weatherInfo?key=${k}&location=${lng},${lat}&extensions=base`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (j.status !== '1' || !Array.isArray(j.lives) || !j.lives[0]) throw new Error('高德天气查询失败: ' + (j.info || 'unknown'));
  const w = j.lives[0];
  return {
    text: w.weather || '',
    temp: Math.round(Number(w.temperature) || 0),
    code: toCode(w.weather || ''),
    humidity: w.humidity || '',
    windDirection: w.winddirection || '',
    windPower: w.windpower || '',
    city: w.city || '',
    province: w.province || '',
    reporttime: w.reporttime || '',
    source: 'amap',
  };
}
