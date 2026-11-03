/**
 * Whether the host of a free-host address (ntfy, generic) is on the public internet: an
 * instance inside a company network must not post, on a signed-in person's say-so, to its
 * loopback, its private ranges, a link-local metadata service or anything else that is not
 * the public internet (spec §6). `localhost` and its subdomains are refused by name, an IP
 * literal by its range, a name when ANY of its addresses is outside the public internet
 * (a name with one public and one private record cannot reach the private one).
 *
 * The check runs when the address is added and again before each send, so the person reads
 * why; the send itself goes through a socket pinned to public addresses (`posters.ts`), so a
 * name re-pointed after this check (DNS rebinding) reaches nothing either.
 */
import { isIP } from 'node:net';

import { isPublicAddress, type Resolver } from '../../http/public-address';

export type Destination = 'public' | 'private' | 'unresolved';

export async function destinationOf(url: URL, resolve: Resolver): Promise<Destination> {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'private';
  if (isIP(host) !== 0) return isPublicAddress(host) ? 'public' : 'private';
  let addresses;
  try {
    addresses = await resolve(host);
  } catch {
    return 'unresolved';
  }
  if (addresses.length === 0) return 'unresolved';
  return addresses.every((a) => isPublicAddress(a.address)) ? 'public' : 'private';
}
