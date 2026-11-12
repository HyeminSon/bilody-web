// 서비스 워커: 알림 + 새 버전이 바로 보이게(화면 파일은 늘 서버에 새것이 있는지 먼저 묻는다).
// GitHub Pages는 파일을 10분 동안 저장해 두게 해서, 이것이 없으면 고친 화면이 늦게 보인다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 동화 묶음·그림처럼 큰 파일은 브라우저 저장을 그대로 쓰고, 화면 파일(html·js·css·json)만 매번 확인한다
  if (req.mode === "navigate" || /\.(js|css|json|webmanifest|html)$/.test(url.pathname) || url.pathname.endsWith("/")) {
    e.respondWith(fetch(req, { cache: "no-cache" }).catch(() => fetch(req)));
  }
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "토리", {
    body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "tori", renotify: true, data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
