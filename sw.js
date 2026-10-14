const CACHE_PREFIX = `english-review:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}v3`;

const ASSET_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./styles.css",
  "./js/app.js",
  "./js/data.js",
  "./js/engine.js",
  "./js/import-worker.js",
  "./js/grammar.js",
  "./js/speech.js"
].map(path => new URL(path, self.registration.scope).href);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSET_URLS);
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();

    await Promise.all(
      names
        .filter(name =>
          name.startsWith(CACHE_PREFIX) &&
          name !== CACHE_NAME
        )
        .map(name => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const shellURL = new URL("./index.html", self.registration.scope).href;
  const isNavigation = event.request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if (!ASSET_URLS.includes(event.request.url) && !isNavigation) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(isNavigation ? shellURL : event.request);

    return saved || fetch(event.request);
  })());
});