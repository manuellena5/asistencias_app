// ============================================================
// Service Worker compartido por las dos apps (index.html y
// carga.html). Un solo SW en la raíz cubre a ambas.
//
// REGLA: cada vez que se toque CUALQUIER archivo del proyecto
// (html, css, js, manifest), hay que incrementar CACHE_NAME.
// El SW es cache-first: sin cambiar la versión, los usuarios con
// la PWA instalada siguen viendo la versión vieja para siempre.
// ============================================================
const CACHE_NAME = 'asistencias-v37';

const CACHED_URLS = [
  './index.html',
  './carga.html',
  './asistencias_app.html',
  './common.css',
  './common.js',
  './reports.js',
  './manifest.json',
  './manifest-carga.json',
  './icon.svg',
  './icon-carga.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache:'reload' evita que el HTTP cache del navegador nos devuelva la
      // versión vieja de un archivo justo cuando estamos precacheando la nueva.
      Promise.all(CACHED_URLS.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => { })
      ))
    )
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
  // Never cache Google Apps Script or Sheets API calls — always fetch live
  if (
    event.request.url.includes('script.google.com') ||
    event.request.url.includes('docs.google.com')
  ) {
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache successful same-origin requests
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
