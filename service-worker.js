// service-worker.js
// NEW FEATURE: makes the app installable and usable with no signal at all —
// the natural next step after the on-device rule-engine fallback the app
// already has (public/index.html falls back to identical local logic when
// the API is slow/unavailable). That fallback still needs the *page itself*
// to have loaded once; this service worker is what lets the page load with
// zero network at all after the first visit, which matters for the poor
// connections this app is built for.
//
// Deliberately simple: cache-first for the app shell (HTML/CSS/JS is all
// inline in index.html, so there's very little to list), network-first for
// API calls (so a citizen with a live connection always gets fresh scheme
// data), and safe to skip entirely — nothing else in the app depends on the
// service worker being registered.

const CACHE_NAME = "am-i-eligible-v1";
const APP_SHELL = ["/", "/index.html", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never cache POST /api/match etc.

  const url = new URL(request.url);

  // API calls: always try the network first (fresh eligibility rules), and
  // only fall back to a cached copy — if any — when fully offline. The app's
  // own JS already has a richer offline path (the local rule engine); this
  // is just a safety net underneath that.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // App shell / static assets: cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
