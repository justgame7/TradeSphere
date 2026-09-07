const CACHE_NAME = 'crypto-screener-v20';
const APP_SHELL = ['./', './index.html', './screener.html', './position-sizing.html', './news.html', './youtube.html', './trump-truth.html', './trading-settings.html', './defi.html', './oil.html', './watchlist.html', './fear-greed.html', './season-index.html', './calendar.html', './prediction-markets.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;

  // Third-party calls (YouTube/news RSS feeds via rss2json, CORS proxies, etc.)
  // must always hit the network fresh. Never fall back to a cached copy here -
  // that would silently serve stale/old data if the request ever fails, with no
  // way for the page to tell the difference (a "refresh" would look like it
  // worked but just replay whatever was last successfully cached, possibly
  // hours old).
  if(!isSameOrigin){
    event.respondWith(fetch(event.request));
    return;
  }

  // Same-origin app shell: network-first, only falling back to cache if the
  // network is genuinely unreachable (e.g. fully offline).
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
