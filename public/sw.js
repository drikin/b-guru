/* B-guru Web Push service worker.
 * Receives a push payload { title, body, url } and shows an OS notification.
 * Clicking the notification opens (or focuses) the linked post.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "B-guru 新着";
  const body = data.body || "";
  const url = data.url || "/";
  const icon = data.icon || "/icon-192.png";

  event.waitUntil(
    self.registration
      .showNotification(title, {
        body,
        icon,
        badge: "/icon-maskable.png",
        data: { url },
      })
      .catch(() => {})
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw =
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : "/";

  // Resolve the target against the SITE ROOT, NOT the SW path. The SW lives at
  // /sw.js, so a relative payload URL (e.g. "#/post/123") must resolve to
  // https://bsm.backspace.fm/#/post/123, never to /sw.js#/post/123 (which would
  // open this source file instead of the post).
  const target = new URL(raw, self.location.origin + "/").href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            // Client.navigate requires an absolute http(s) URL.
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
      .catch(() => {})
  );
});
