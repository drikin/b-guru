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
  const target =
    event.notification.data && event.notification.data.url ? event.notification.data.url : "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
      .catch(() => {})
  );
});
