// A service worker is a script that runs in the background, separate from the page.
// Its main superpower here: it can intercept network requests and serve cached
// files instead - which is what makes the app usable with zero signal at a range.

const CACHE_NAME = 'project-procedural-v1';
const FILES_TO_CACHE = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

// 'install' fires once, when the service worker is first registered.
// We use it to pre-download and cache every file the app needs.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
});

// 'fetch' fires every time the page requests something (HTML, CSS, JS...).
// We try the cache first; if it's not there, fall back to the network.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// 'activate' fires when a new version of the service worker takes over.
// We use it to delete old caches so updates don't pile up storage forever.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
});
