const STATIC_CACHE = 'planetgame-static-v2';
const RUNTIME_CACHE = 'planetgame-runtime-v2';
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/bgm/puzzle-game.mp3',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/images/1_冥王星.png',
  '/images/2_月.png',
  '/images/3_水星.png',
  '/images/4_火星.png',
  '/images/5_金星.png',
  '/images/6_地球.png',
  '/images/7_天王星.png',
  '/images/8_海王星.png',
  '/images/9_土星.png',
  '/images/10_木星.png',
  '/images/11_太陽.png',
  '/images/backgroundimage.jpg'
];

async function cacheBuildAssets(cache) {
  const response = await fetch('/');
  const html = await response.text();
  const assetPaths = Array.from(
    html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
    (match) => match[1]
  );
  const uniqueAssetPaths = [...new Set(assetPaths)];
  await cache.addAll(uniqueAssetPaths);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      await cacheBuildAssets(cache);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('/');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (!response.ok) return response;
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/'));
    })
  );
});
