// 京都・名古屋 2027 行程網站：離線快取（Service Worker）
// ─────────────────────────────────────────────
// 策略：
//   • 網頁本身（index.html）：有網路先抓最新版，但最多等 3 秒；
//     訊號弱或沒網路就立刻改用手機裡存的版本 → 地下街、山區也打得開。
//   • 圖示（icons.js）、字型、manifest 等靜態資源：Cache First（先用手機裡的，背景再更新）。
//   • Google 地圖、導航等外部服務：照常連網，不快取。
// 更新網站後想強制所有人換新快取，把 CACHE 版本號加 1。
importScripts('./covers.js');  // 主題封面照片清單（self.KYOTO_COVERS）
const CACHE = 'kyoto2027-v5';
// 主題封面照片：安裝時全部先存好（換照片時把版本號加 1）
const COVER_CACHE = 'kyoto2027-covers-v1';
// 看過的地點照片另外存一份（最多 IMG_MAX 張，舊的自動刪），沒網路時卡片照片也看得到
const IMG_CACHE = 'kyoto2027-img';
const IMG_MAX = 150;

// 安裝時就先存好的檔案（同網域）
const CORE = ['./', './index.html', './icons.js', './covers.js', './manifest.json', './icon-192.png', './icon-512.png'];
// 安裝時一併預先下載的外部資源（字型樣式；圖示已放在本站 icons.js）
const CDN_PRECACHE = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;700;900&family=DM+Serif+Display&display=swap'
];
// 執行時遇到就快取的外部網域（字型檔等）
const CDN_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];
const NAV_TIMEOUT = 3000;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    // 外部資源一個一個存，某一個失敗不影響其他
    await Promise.allSettled(CDN_PRECACHE.map(async url => {
      const res = await fetch(new Request(url, { mode: 'no-cors' }));
      if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
    }));
    // 主題封面照片（約 50 張、合計約 1–2 MB）
    const cc = await caches.open(COVER_CACHE);
    const have = new Set((await cc.keys()).map(r => r.url));
    await Promise.allSettled(self.KYOTO_COVERS.all.filter(u => !have.has(u)).map(async url => {
      let res = await fetch(url, { mode: 'cors' }).catch(() => null);
      if (!res || !res.ok) res = await fetch(new Request(url, { mode: 'no-cors' }));
      if (res && (res.ok || res.type === 'opaque')) await cc.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== IMG_CACHE && k !== COVER_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  return (await cache.match(req, { ignoreSearch: true })) || null;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) 網頁本身：網路優先（3 秒逾時）→ 失敗用快取
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      });
      try {
        return await Promise.race([net, timeout(NAV_TIMEOUT)]);
      } catch (err) {
        const hit = (await cache.match('./index.html')) || (await cache.match('./'));
        if (hit) { net.catch(() => {}); return hit; }
        return net; // 第一次開、還沒快取時只能等網路
      }
    })());
    return;
  }

  // 2) 外部照片（主題封面＋自訂 imageUrl）：Cache First；先找預存的封面，再找看過的照片
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = (await caches.match(req.url)) || (await cache.match(req));
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          e.waitUntil((async () => {
            await cache.put(req, res.clone());
            const keys = await cache.keys();
            for (let i = 0; i < keys.length - IMG_MAX; i++) await cache.delete(keys[i]);
          })());
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // 3) 同網域靜態檔與 CDN：Cache First，背景更新
  if (url.origin === location.origin || CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: url.origin === location.origin });
      const update = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(update); return hit; }
      const res = await update;
      return res || new Response('', { status: 504, statusText: 'offline' });
    })());
  }
  // 4) 其他（Google 地圖等）不攔截
});
