/**
 * The two ways a message leaves for a messaging address: one JSON POST, the HTTP status
 * back, a throw for no answer. Never a redirect followed, 10 s at most, the answer's body
 * never read.
 *
 *   fetchPoster        `fetch` (the vendors' fixed hosts; and every host in tests, which
 *                      inject a fake `fetch`)
 *   publicOnlyPoster   `node:https` whose socket only reaches the addresses a single
 *                      resolution found public, the peer checked again once connected: the
 *                      free hosts (ntfy, generic) cannot be re-pointed inside the network
 *                      between the check and the connection (DNS rebinding)
 */
import { request } from 'node:https';

import { isPublicAddress, publicOnlyLookup, type Resolver } from '../../http/public-address';

/** A messaging service that does not answer in this delay is a failure, not a wait. */
export const MESSAGING_TIMEOUT_MS = 10_000;

/** Posts `json` to `url` and answers the HTTP status; throws when nothing answered. */
export type Poster = (url: string, json: unknown) => Promise<number>;

const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'vaubaan-gateway' } as const;

export class PrivateDestinationError extends Error {
  constructor() {
    super('the host does not resolve to a public address');
    this.name = 'PrivateDestinationError';
  }
}

export function fetchPoster(fetchImpl: typeof fetch): Poster {
  return async (url, json) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(json),
      redirect: 'error',
      signal: AbortSignal.timeout(MESSAGING_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  };
}

export function publicOnlyPoster(resolve: Resolver): Poster {
  const lookup = publicOnlyLookup(resolve, () => new PrivateDestinationError());
  return (url, json) =>
    new Promise<number>((settle, reject) => {
      const body = Buffer.from(JSON.stringify(json), 'utf8');
      const req = request(
        url,
        {
          method: 'POST',
          lookup,
          // One connection per message: nothing pooled, nothing reused.
          agent: false,
          headers: { ...HEADERS, 'Content-Length': String(body.length) },
        },
        (res) => {
          const peer = res.socket.remoteAddress;
          if (!peer || !isPublicAddress(peer)) {
            req.destroy(new PrivateDestinationError());
            return;
          }
          clearTimeout(deadline);
          // The answer's body is never read: the status is the whole outcome.
          res.resume();
          settle(res.statusCode ?? 0);
        },
      );
      const deadline = setTimeout(() => {
        req.destroy(new Error('the messaging service did not answer in time'));
      }, MESSAGING_TIMEOUT_MS);
      req.on('error', (err) => {
        clearTimeout(deadline);
        reject(err);
      });
      req.end(body);
    });
}
