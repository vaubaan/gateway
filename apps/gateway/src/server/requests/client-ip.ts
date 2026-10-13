/**
 * The client address a surface rate limit is keyed on (spec §6 "surface rate
 * limits … on the request page per IP").
 *
 * The instance always sits behind the company's TLS terminator, and a Fetch
 * `Request` does not expose the socket peer. `X-Forwarded-For` is therefore
 * the only source, and it is believed only as far as the configuration says
 * (`trusted_proxies`): the address returned is the right-most entry that is
 * not itself a trusted proxy — the first hop the company's own
 * infrastructure did not write. With no trusted proxy configured the header
 * is ignored altogether and every caller shares one key, so the limit still
 * holds (as a global one) instead of being bypassed by a forged header.
 */
import { BlockList, isIP } from 'node:net';

/** Key used when no client address can be trusted. */
export const UNKNOWN_CLIENT = 'unknown';

const IPV4_BITS = 32;
const IPV6_BITS = 128;

function family(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  if (version === 4) return 'ipv4';
  if (version === 6) return 'ipv6';
  return null;
}

/** The matcher of `trusted_proxies` (plain addresses or CIDR blocks). Invalid entries are skipped. */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.trim().split('/');
    const kind = address ? family(address) : null;
    if (!address || !kind) continue;
    if (prefix === undefined) {
      list.addAddress(address, kind);
      continue;
    }
    const bits = Number(prefix);
    const max = kind === 'ipv4' ? IPV4_BITS : IPV6_BITS;
    if (prefix !== '' && Number.isInteger(bits) && bits >= 0 && bits <= max) {
      list.addSubnet(address, bits, kind);
    }
  }
  return list;
}

/** `[::1]:1234`, `1.2.3.4:1234` → the bare address. */
function bareAddress(raw: string): string {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) return bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  return withPort?.[1] ?? value;
}

export function clientIpOf(headers: Headers, trusted: BlockList, hasTrusted: boolean): string {
  if (!hasTrusted) return UNKNOWN_CLIENT;
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map(bareAddress)
    .filter((hop) => hop !== '');
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i];
    const kind = hop ? family(hop) : null;
    // A malformed hop: nothing to its left can be believed either.
    if (!hop || !kind) return UNKNOWN_CLIENT;
    if (!trusted.check(hop, kind)) return hop;
  }
  return UNKNOWN_CLIENT;
}

/** `clientIpOf` bound to the configuration's `trusted_proxies`. */
export function clientIpResolver(trustedProxies: readonly string[]): (headers: Headers) => string {
  const list = trustedProxyList(trustedProxies);
  const hasTrusted = trustedProxies.length > 0;
  return (headers) => clientIpOf(headers, list, hasTrusted);
}
