// Burrow's service worker: it shows alerts that arrive while Burrow is closed (on a phone
// that's the home-screen app), and opens the right conversation when one is tapped. It keeps
// a copy of the app's own files so Burrow still opens with no connection (it always loads
// fresh from your server when it can), and catches things shared to Burrow from other apps.

const APP_CACHE = 'burrow-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('burrow-app-') && name !== APP_CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share') return e.respondWith(receiveShare(req));
  // Messages, files and the live connection always go to the server; the camera background's
  // big model isn't worth keeping.
  if (req.method !== 'GET' || req.headers.has('range') || /^\/(api|ws)\//.test(url.pathname) || url.pathname.startsWith('/vendor/mediapipe/')) return;
  if (req.mode === 'navigate' || /\.(js|css|png|svg|woff2?|webmanifest|json|wasm|ico|html)$/.test(url.pathname)) e.respondWith(networkFirst(req));
});

// The server's copy when it answers, the saved one when it doesn't.
async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? '/' : req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const saved = await cache.match(req.mode === 'navigate' ? '/' : req, { ignoreSearch: req.mode === 'navigate' });
    if (saved) return saved;
    throw err;
  }
}

// Shared from another app: keep it for the page, which asks which room it goes to.
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    await caches.delete('burrow-share');
    const cache = await caches.open('burrow-share');
    await Promise.all(files.slice(0, 10).map((f, i) => cache.put(`/shared/file-${i}`, new Response(f, {
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `shared-${i}`) },
    }))));
    await cache.put('/shared/meta', new Response(JSON.stringify({
      title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: Math.min(files.length, 10),
    }), { headers: { 'content-type': 'application/json' } }));
  } catch {}
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    if (typeof m.badge === 'number' && self.navigator.setAppBadge) {
      await (m.badge ? self.navigator.setAppBadge(m.badge) : self.navigator.clearAppBadge()).catch(() => {});
    }
    await self.registration.showNotification(m.title || 'Burrow', {
      body: m.body || '',
      tag: m.tag,
      renotify: !!m.tag,
      silent: !!m.silent,
      icon: 'icon-192.png',
      badge: 'badge.png',
      timestamp: Date.now(),
      data: { channelId: m.channelId, messageId: m.messageId },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { channelId, messageId } = e.notification.data || {};
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = open.find((w) => w.focused) || open[0];
    if (win) {
      win.postMessage({ type: 'open', channelId, messageId });
      return win.focus();
    }
    return self.clients.openWindow(channelId ? `./?channel=${channelId}&message=${messageId || ''}` : './');
  })());
});
