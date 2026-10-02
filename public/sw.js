/* Alcor Web · Service Worker（PWA 安装与离线兜底）
 * 策略：公开静态/上传资源网络优先，离线回退本 worker 的缓存；
 * 账户页面、私有文件与动态 API 不进入共享离线缓存。
 */
const CACHE = "fire-pwa-v5";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("fire-pwa-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // HTML embeds the current account's data. Never retain or replay it after logout.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => offlineResponse()));
    return;
  }
  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }
  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    (url.pathname.startsWith("/uploads/") &&
      !/^\/uploads\/reports(?:\/|%2f|%5c|$)/i.test(url.pathname) &&
      !/(?:\/|%2f|%5c)\.draft-/i.test(url.pathname));
  if (!cacheable) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && (response.type === "basic" || response.type === "default") &&
          !/(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get("cache-control") || "")) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await (await caches.open(CACHE)).match(request);
        if (cached) return cached;
        return offlineResponse();
      })
  );
});

function offlineResponse() {
  return new Response("离线模式：请恢复网络后重试", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}
