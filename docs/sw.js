// Brief service worker.
// Shell: cache-first. ./data/*.json and ./data/articles/*.json: network-first, falling back to the
// last copy, so an article read once still opens offline. Only the newest ARTICLE_KEEP article files
// are kept in the data cache (the pool is 72 h ≈ 9 drops).
// To bust every client's cache after a shell change, bump CACHE_VERSION.

const CACHE_VERSION = 'v2-poster-2-reader';
const SHELL_CACHE = `brief-shell-${CACHE_VERSION}`;
const DATA_CACHE = 'brief-data'; // unversioned: keep the last good data across shell bumps
const ARTICLE_KEEP = 12;
const isData = (p) => /\/data\/(?:articles\/)?[^/]+\.json$/.test(p);
const isArticle = (p) => /\/data\/articles\/[^/]+\.json$/.test(p);

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './rank.js',
  './taste.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('brief-shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts etc. go straight to network

  if (isData(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const key = new URL(req.url).pathname; // ignore query strings
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(key, res.clone());
      if (isArticle(key)) await trimArticles(cache);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function trimArticles(cache) {
  const keys = (await cache.keys()).map((r) => new URL(r.url).pathname).filter(isArticle).sort();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - ARTICLE_KEEP)).map((k) => cache.delete(k)));
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  // Navigations with debug params (?tab=…) still map to the cached shell.
  const hit = (await cache.match(req, { ignoreSearch: true })) ||
    (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && new URL(req.url).origin === self.location.origin) cache.put(req, res.clone());
  return res;
}
