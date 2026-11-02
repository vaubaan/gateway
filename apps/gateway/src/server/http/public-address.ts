/**
 * The public internet, as opposed to every special-purpose range (IANA registries): what
 * the instance may reach when a signed-in person, not the operator, chose the address.
 * Used by the client metadata documents of the OAuth server and by the messaging
 * addresses of notifications whose host is free (ntfy, generic). Host-agnostic.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/** Every range that is not the public internet (IANA special-purpose registries). */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible block (`::a.b.c.d`).
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  // Site-local, deprecated by RFC 3879 and still routed inside some sites.
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Whether an IP address is on the public internet. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED_IPV4.exec(address);
  const bare = mapped?.[1] ?? address;
  const version = isIP(bare);
  if (version === 4) return !NON_PUBLIC.check(bare, 'ipv4');
  if (version === 6) {
    // An IPv4-mapped address written in hexadecimal (`::ffff:7f00:1`) is refused whole.
    if (/^::ffff:/i.test(bare)) return false;
    return !NON_PUBLIC.check(bare, 'ipv6');
  }
  return false;
}

/** Every address a name resolves to (tests inject a fake). */
export type Resolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * A `lookup` for `net.connect` that resolves the name once and hands the socket only public
 * addresses: if any address of the name is not public the whole lookup fails with
 * `refusal()`, so a name with one public and one private record cannot be used to reach the
 * private one, and a name re-pointed after a check reaches nothing (DNS rebinding).
 */
export function publicOnlyLookup(resolve: Resolver, refusal: () => Error): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
          callback(refusal(), '');
          return;
        }
        if (options.all) {
          callback(null, [...addresses]);
          return;
        }
        const first = addresses[0];
        if (first) callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), '');
      },
    );
  };
}
