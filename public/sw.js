self.ECHO_CACHE = "echo-codex-v143";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(self.ECHO_CACHE).then((cache) =>
      cache.addAll([
        "/",
        "/styles.css?v=141",
        "/app.js?v=142",
        "/manifest.webmanifest?v=135",
        "/vendor/markdown-it-14.1.0.min.js?v=135",
        "/vendor/dompurify-3.2.6.min.js?v=135"
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== self.ECHO_CACHE).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
  );
});
