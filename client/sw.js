// Burrow's service worker: it shows alerts that arrive while Burrow is closed (on a phone
// that's the home-screen app), and opens the right conversation when one is tapped.
// It doesn't cache anything; Burrow always loads fresh from your server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
