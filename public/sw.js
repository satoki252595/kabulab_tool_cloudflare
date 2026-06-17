// 旧 kabulab.vercel.app の Service Worker (/sw.js, scope: /) の後始末用。
// 既に登録済みのブラウザが /sw.js を再フェッチした際に、自身を unregister しキャッシュを破棄する。
// 新しい SW は /otakara-yutai/sw.js (scope: /otakara-yutai/) として登録される。
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});
