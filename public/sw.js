/* Bunny's Home — Service Worker
   策略：
   - /api/* 与跨域请求：永远走网络、绝不缓存（保证登录 / AI / 日历 / 任务 / 习惯 / 计划数据实时同步）。
   - 导航（HTML）：网络优先，失败才回退缓存首页（新版本部署后立即生效，离线也能打开壳）。
   - 静态资源（图片 / 字体 / 样式 / 图标）：缓存优先 + 后台更新（stale-while-revalidate）。
   部署新版本：改 VERSION 并同步 index.html 即可让旧 SW 自更新（skipWaiting + clients.claim + 版本化缓存名）。
*/
const VERSION = 'bunny-home-v3';
const CACHE = VERSION;
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];
const STATIC_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|css|ttf|otf|woff2?|eot|webmanifest)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐项加入，单个失败不阻断安装
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 跨域（后端 API / 第三方）不拦截，交给网络
  if (url.origin !== self.location.origin) return;

  // API 请求：只走网络，不缓存，避免数据不同步
  if (url.pathname.startsWith('/api/')) return;

  // 导航：网络优先，离线回退缓存首页
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const copy = fresh.clone();
          const cache = await caches.open(CACHE);
          cache.put('index.html', copy);
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match('index.html');
        return cached || caches.match('./');
      }
    })());
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then(async (res) => {
        if (res && res.ok) {
          const copy = res.clone();
          const cache = await caches.open(CACHE);
          cache.put(req, copy);
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
