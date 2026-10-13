/**
 * The client address of a request — the ONE reading of `trusted_proxies` and
 * `X-Forwarded-For` in the instance. The request page keys its surface rate
 * limit on it (spec §6 "on the request page per IP"); the execution door
 * writes it to the audit entry and keys the token-verification throttle on it;
 * the config loader validates `trusted_proxies` with the same entry parser.
 *
 * The instance always sits behind the company's TLS terminator, and a Fetch
 * `Request` does not expose the socket peer. `X-Forwarded-For` is therefore
 * the only source, and it is believed only as far as the configuration says
 * (`trusted_proxies`): the address returned is the right-most entry that is
 * not itself a trusted proxy — the first hop the company's own
 * infrastructure did not write. With no trusted proxy configured the header
 * is ignored altogether and every caller shares one key, so a limit keyed on
 * the address still holds (as a global one) instead of being bypassed by a
 * forged header.
 */
import { BlockList, isIP } from 'node:net';

/** Key used when no client address can be trusted. */
export const UNKNOWN_CLIENT = 'unknown';

const IPV4_BITS = 32;
const IPV6_BITS = 128;

type Family = 'ipv4' | 'ipv6';

function family(address: string): Family | null {
  const version = isIP(address);
  if (version === 4) return 'ipv4';
  if (version === 6) return 'ipv6';
  return null;
}

/** One `trusted_proxies` entry: a plain address (`bits: null`) or a CIDR block. */
interface TrustedProxyEntry {
  readonly address: string;
  readonly family: Family;
  readonly bits: number | null;
}

/** Surrounding spaces are ignored; the prefix length must be a whole number within the family. */
function parseTrustedProxyEntry(entry: string): TrustedProxyEntry | null {
  const [address = '', prefix, ...rest] = entry.trim().split('/');
  const kind = family(address);
  if (!kind || rest.length > 0) return null;
  if (prefix === undefined) return { address, family: kind, bits: null };
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  const max = kind === 'ipv4' ? IPV4_BITS : IPV6_BITS;
  return bits <= max ? { address, family: kind, bits } : null;
}

/** Whether a `trusted_proxies` entry is an IP address or a CIDR block (config validation). */
export function isTrustedProxyEntry(entry: string): boolean {
  return parseTrustedProxyEntry(entry) !== null;
}

/** The matcher of `trusted_proxies` (plain addresses or CIDR blocks). Invalid entries are skipped. */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const parsed = parseTrustedProxyEntry(entry);
    if (!parsed) continue;
    if (parsed.bits === null) list.addAddress(parsed.address, parsed.family);
    else list.addSubnet(parsed.address, parsed.bits, parsed.family);
  }
  return list;
}

/** `[::1]:1234`, `[::1]`, `1.2.3.4:1234` → the bare address. */
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
