const CACHE = 'lazyshift-v33';

// The whole app shell, so the app starts with no network after one
// online visit. The Supabase library is self-hosted under a versioned
// path (see /vendor/), never loaded from a CDN.
const SUPABASE_JS = '/vendor/supabase-js-2.117.2/supabase.js';
const ASSETS = [
  '/',
  '/index.html',
  '/salary-calculator.html',
  '/login.html',
  '/terms.html',
  '/refund.html',
  '/privacy.html',
  '/articles/leave-in-shifts.html',
  '/articles/night-shift-bonus.html',
  '/articles/overtime.html',
  '/articles/shift-timesheet.html',
  '/articles/shift-work-burnout.html',
  '/articles/shifts-port-hospital-security.html',
  '/style.css',
  '/article.css',
  '/app.js',
  '/auth.js',
  '/consent.js',
  SUPABASE_JS,
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// How long a page or script may wait for the network before the cached
// copy is used instead (bad signal on a night shift is not "offline").
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(
    // cache: 'reload' skips the browser's HTTP cache, so a new version
    // never precaches the previous version's files.
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only our own static files. Supabase, Lemon Squeezy, Google Analytics
  // and /api/ go straight to the network and are never cached.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isPage = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  const isScript = url.pathname.endsWith('.js') && !url.pathname.startsWith('/vendor/');

  // Pages and scripts: network first, so a deploy reaches users on the
  // next load. Everything else (css, icons, the versioned vendor
  // library): cache first; a new cache version re-downloads them.
  e.respondWith(isPage || isScript ? networkFirst(req, isPage) : cacheFirst(req));
});

async function networkFirst(req, isPage) {
  // Stored without the query string (?utm_source=...), one entry per file.
  const key = req.url.split(/[?#]/)[0];
  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy));
      }
      return res;
    });

  const cached = await findCached(req, isPage);
  if (!cached) return network.then(clean, () => offlineResponse(isPage));

  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  const res = await Promise.race([network.catch(() => null), timeout]);
  // A server error is not better than yesterday's working copy.
  return res && res.ok ? clean(res) : clean(cached);
}

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return clean(cached);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  } catch {
    return offlineResponse(false);
  }
}

async function findCached(req, isPage) {
  const cached = await caches.match(req.url, { ignoreSearch: true });
  if (cached || !isPage) return cached;
  // Clean URLs (/salary-calculator) are the same page as the .html file.
  const url = new URL(req.url);
  if (!url.pathname.endsWith('/') && !url.pathname.endsWith('.html')) {
    return caches.match(url.pathname + '.html');
  }
  return caches.match(url.pathname + 'index.html');
}

// A redirected response can't answer a navigation, so copy it into a
// fresh one (same body and headers).
function clean(res) {
  if (!res.redirected) return res;
  return res.blob().then(body => new Response(body, {
    status: res.status, statusText: res.statusText, headers: res.headers,
  }));
}

function offlineResponse(isPage) {
  return new Response(
    isPage ? '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><p style="font-family:sans-serif;padding:24px">You\'re offline and this page hasn\'t been saved yet. <a href="/">Open LazyShift</a></p>' : '',
    { status: 503, headers: { 'Content-Type': isPage ? 'text/html; charset=utf-8' : 'text/plain' } }
  );
}

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'LazyShift';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.url || '/',
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(e.notification.data || '/')
  );
});
