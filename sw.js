const CACHE = 'plr-v34';
// лёгкое — сразу; тяжёлые библиотеки докачаются и закэшируются при первом использовании
const ASSETS = ['./', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    // переходы/запуск со значка: сначала сеть (всегда свежая версия),
    // без сети — кэш. Редиректы в кэш не пишем.
    e.respondWith(
      fetch(e.request).then((res) => {
        try {
          if (res && res.ok && !res.redirected && new URL(e.request.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
        } catch (e) {}
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./')))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    try {
      // в кэш — только обычные 200-ответы со своего адреса, без редиректов
      if (res && res.ok && !res.redirected && new URL(e.request.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
    } catch (e) {}
    return res;
  }).catch(() => caches.match('./'))));
});
