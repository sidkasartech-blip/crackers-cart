// Minimal service worker: lets the admin page show new-order notifications on Android phones.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const admin = list.find((c) => c.url.includes('/admin'));
    return admin ? admin.focus() : self.clients.openWindow('/admin#orders');
  }));
});
