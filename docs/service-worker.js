// StockPilot service worker — caches the app shell so it opens instantly
// and works with no internet connection. Bump CACHE_NAME whenever you
// change index.html/app.js so phones pick up the new version.
const CACHE_NAME = "stockpilot-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never intercept Firebase/Firestore traffic — that needs to hit the
  // network live for real-time sync to work, not be cached or replayed.
  if (/googleapis\.com|firebaseio\.com|firebaseapp\.com/.test(req.url)) return;

  // Network-first for the app shell files so updates show up quickly;
  // cache-first for everything else (CDN libraries, icons) for offline use.
  const isAppShell = ASSETS.some((a) => req.url.endsWith(a.replace("./", "")));
  if (isAppShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached))
    );
  }
});
