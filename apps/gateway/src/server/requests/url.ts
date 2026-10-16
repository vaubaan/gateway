/**
 * The one builder of a request URL (spec §3.4: "the gateway … puts the
 * request's URL into the refusal"; §6: "provider callbacks and request URLs
 * carry [the public URL]").
 *
 * `<public_url>/r/<request_id>` is what a `budget-exhausted` or
 * `approval-required` refusal hands to the executor; `/r/<id>` is the route
 * that answers it. Both are written here and nowhere else: the budget's
 * `SessionService` receives `requestUrlBuilder(config.publicUrl)` as its
 * `requestUrl` dependency, the route file sits next to this prefix.
 */

/** Path prefix of the forwarded request URL. The route lives at `app/r/[id]`. */
export const REQUEST_PATH_PREFIX = '/r';

/** Path of the inbox ("Waiting for you"); the creator's view of one request is `/waiting/<id>`. */
export const INBOX_PATH = '/waiting';

/** `/r/<id>` — the path a refusal carries, relative to the public URL. */
export function requestPath(requestId: string): string {
  return `${REQUEST_PATH_PREFIX}/${encodeURIComponent(requestId)}`;
}

/** `/waiting/<id>` — where the creator reads and decides the request. */
export function inboxRequestPath(requestId: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(requestId)}`;
}

/** `<public_url>/r/<id>`. */
export function requestUrl(publicUrl: URL, requestId: string): string {
  return `${publicUrl.origin}${requestPath(requestId)}`;
}

/** The `requestUrl` dependency of the budget's `SessionService`. */
export function requestUrlBuilder(publicUrl: URL): (requestId: string) => string {
  return (requestId) => requestUrl(publicUrl, requestId);
}
