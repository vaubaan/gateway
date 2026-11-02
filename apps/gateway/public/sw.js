/*
 * The service worker of the Vaubaan Gateway interface (spec §4.2 bis; handbook
 * notifications). It does two things and only these:
 *
 *   push               shows the notification the instance sent (title, body, the page
 *                      it leads to), decrypted by the browser;
 *   notificationclick  focuses a window already on that page, or opens one.
 *
 * It caches nothing, intercepts no request and serves nothing offline: every page of
 * the interface carries authorization, and a cached one would show what a person may
 * no longer see. There is no `fetch` listener on purpose; do not add one.
 *
 * A notification never answers anything: opening it leads to the interface, where a
 * yes is given in a human session (spec §6).
 */

const FALLBACK_TITLE = 'Vaubaan';
const ICON = '/logo-vaubaan.png';

/** A path of this instance, or the home: never another origin. */
function pathOf(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function textOf(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const path = pathOf(data.url);
  event.waitUntil(
    self.registration.showNotification(textOf(data.title, FALLBACK_TITLE), {
      body: textOf(data.body, ''),
      tag: textOf(data.tag, path),
      icon: ICON,
      data: { path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const resolved = new URL(
    pathOf(event.notification.data && event.notification.data.path),
    self.location.origin,
  );
  // `/\evil.example` passes `pathOf` and resolves elsewhere: only this origin is opened.
  const target =
    resolved.origin === self.location.origin ? resolved : new URL('/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target.href && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
