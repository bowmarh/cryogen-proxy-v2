// The club dashboard as an installable app. It keeps the page and its scripts so the app opens when the network is down, and still fetches them
// fresh first whenever the network is up, so a new deploy shows straight away. Nothing from /api/ is ever kept: a rider's data is not stored by the worker.
const CACHE = 'cryogen-shell-v10';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/logo.png', '/js/app.js', '/js/staff.js', '/js/errors.js', '/js/ui.js', '/js/fit.js', '/js/coach.js', '/js/support.js', '/js/aistaff.js', '/js/studio.js', '/js/mailui.js', '/js/aidesk.js', '/js/control.js', '/js/captain.js', '/js/mydetails.js', '/js/planui.js', '/js/referral.js', '/js/feedback.js',
  '/js/investigate.js', '/js/pairfit.js', '/js/pairui.js', '/js/caselogui.js', '/js/privacyui.js', '/js/membercards.js', '/js/clubstatsui.js', '/js/calendar-settings.js', '/js/authui.js', '/js/zrlpast.js', '/js/myseason.js', '/js/teamchange.js'];

self.addEventListener('install', e => {
  // One missing file must not stop the worker installing, so each is added on its own.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// A message from the club: shown as a notification; tapping it opens the dashboard.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'CRYO-GEN').slice(0, 80), { body: String(d.body || '').slice(0, 300), icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { const w = list.find(c => c.url.startsWith(self.location.origin)); return w ? w.focus() : self.clients.openWindow(url); }))
});

// Pages and the app's own files: network first (fresh), the saved copy only when the network fails. Pages are always saved under "/".
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  const own = (r.mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html')) || /^\/(js\/[\w.-]+\.js|manifest\.json|icon-\d+\.png|logo\.png|apple-touch-icon\.png)$/.test(u.pathname);
  if (!own) return;
  const key = r.mode === 'navigate' ? '/' : r;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; })
    .catch(() => caches.match(key).then(hit => hit || (r.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
