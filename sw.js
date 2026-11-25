const CACHE_NAME = 'borb-rpg-pwa-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles/theme.css',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/main.js',
  './src/core/rpgMath.js',
  './src/core/turnLogic.js',
  './src/db/database.js',
  './src/db/savePoint.js',
  './src/services/geminiApi.js',
  './src/ui/radarChart.js',
  './src/ui/components.js',
  './src/ui/modals.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Gemini API calls or non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.hostname.includes('generativelanguage.googleapis.com')
  ) {
    return;
  }

  // Cache-first with background network refresh scoped strictly to this app's relative path (GitHub Pages safe)
  if (url.href.startsWith(self.registration.scope)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            if (event.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return cached;
          });

        return cached || networkFetch;
      })
    );
  }
});
