/**
 * The messaging transport: one JSON POST to one address, and what its answer means.
 *
 *   2xx                delivered
 *   anything else      failed, with the HTTP status: recorded, never retried
 *   no answer          failed, status `null` (timeout, DNS, TLS, a redirect)
 *   refused            the URL no longer passes the rules of its kind, or its host does not
 *                      resolve to the public internet: nothing leaves
 *
 * Egress rules (spec §6): https only, no credentials in the URL, no redirect followed, 10 s
 * per request (`posters.ts`). A free host (ntfy, generic) is checked by name first, for a
 * refusal the person can read, then reached through a socket pinned to public addresses.
 * The URL is a secret of the person: it never leaves this file but in the request itself,
 * and no outcome carries it.
 */
import type { Resolver } from '../../http/public-address';
import { checkAddressUrl, hostIsFree, type AddressKind } from './address-rules';
import { destinationOf } from './destination';
import { outgoingRequest, type OutgoingMessage } from './messages';
import { PrivateDestinationError, type Poster } from './posters';

export type MessagingOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'failed'; readonly status: number | null }
  | {
      readonly kind: 'refused';
      readonly refusal: 'invalid-address' | 'wrong-host' | 'private-destination' | 'unresolved';
    };

/** Sends one message to one address; never throws. */
export interface MessagingTransport {
  send(kind: AddressKind, url: string, message: OutgoingMessage): Promise<MessagingOutcome>;
}

export interface MessagingTransportDeps {
  /** To the vendors' fixed hosts (Slack, Teams, Discord). */
  readonly vendorPost: Poster;
  /** To a free host (ntfy, generic): pinned to public addresses in production. */
  readonly freeHostPost: Poster;
  /** Name resolution of the free hosts, for the check by name (tests inject a fake). */
  readonly resolve: Resolver;
}

export function createMessagingTransport(deps: MessagingTransportDeps): MessagingTransport {
  return {
    async send(kind, raw, message) {
      // Checked when the address was added; checked again, the rules or the DNS may have moved.
      const checked = checkAddressUrl(kind, raw);
      if (!checked.ok) return { kind: 'refused', refusal: checked.problem };
      const free = hostIsFree(kind);
      if (free) {
        const destination = await destinationOf(checked.url, deps.resolve);
        if (destination === 'private') return { kind: 'refused', refusal: 'private-destination' };
        if (destination === 'unresolved') return { kind: 'refused', refusal: 'unresolved' };
      }
      const request = outgoingRequest(kind, checked.url, message);
      try {
        const status = await (free ? deps.freeHostPost : deps.vendorPost)(
          request.url,
          request.json,
        );
        return status >= 200 && status < 300 ? { kind: 'delivered' } : { kind: 'failed', status };
      } catch (err) {
        // Re-pointed inside the network since the check: refused at the socket.
        if (err instanceof PrivateDestinationError) {
          return { kind: 'refused', refusal: 'private-destination' };
        }
        return { kind: 'failed', status: null };
      }
    },
  };
}
