const CACHE_PREFIX = `english-review:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}v1`;

const ASSET_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
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

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (!ASSET_URLS.includes(event.request.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(event.request);

    return saved || fetch(event.request);
  })());
});