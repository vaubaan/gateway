/**
 * The push services the instance posts to: those of the browser vendors, reached outbound
 * without an account (spec §8). A subscription is a URL its browser hands over, and the
 * person posting it is signed in, not trusted with the instance's network: an endpoint
 * outside these hosts, or not `https`, is refused when the device is added and never
 * reached (no request to an internal address on someone's say-so).
 *
 * The same list is what an egress allowlist must open (docs/handbook/configuration.md).
 * A browser whose push service is not listed cannot subscribe; adding one is a change here.
 */

/** Host suffixes of the push services, one per vendor. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  // Chrome, Edge on Android, Samsung Internet, Opera, Brave: Firebase Cloud Messaging.
  'fcm.googleapis.com',
  // Firefox: Mozilla's autopush.
  'push.services.mozilla.com',
  // Safari on macOS, iOS and iPadOS (16.4 and later, installed to the Home Screen).
  'push.apple.com',
  // Edge on Windows: Windows Push Notification Services.
  'notify.windows.com',
];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Whether the instance may post to this endpoint. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((suffix) => hostMatches(host, suffix));
}
