/**
 * `plugins.private_hosts` read (ADR plugins-reach-the-public-internet-only): what plugins
 * may reach inside the network besides the public internet. No dependency: the
 * configuration checks it at load, `plugin-fetch.ts` enforces it on every socket.
 */
import { BlockList, isIP } from 'node:net';

import { isPublicAddress } from './public-address';

/** A DNS label: letters, digits, `_` and inner `-`, 63 characters at most. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** A host name: dot-separated labels, 253 characters at most. Checked label by label. */
function isHostName(entry: string): boolean {
  return entry.length >= 1 && entry.length <= 253 && entry.split('.').every((l) => LABEL.test(l));
}

/** What `plugins.private_hosts` lists, read: host names, and address ranges. */
export interface PrivateHosts {
  readonly names: ReadonlySet<string>;
  readonly ranges: BlockList;
}

/**
 * Reads `plugins.private_hosts`: a CIDR range (`10.0.0.0/8`, `fd00::/8`), an IP address,
 * or a host name, matched exactly and case-insensitively. Throws on an entry that is none.
 */
export function parsePrivateHosts(entries: readonly string[]): PrivateHosts {
  const names = new Set<string>();
  const ranges = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry);
    if (cidr) {
      const [, address = '', bits = ''] = cidr;
      const version = isIP(address);
      const prefix = Number(bits);
      if (version === 0 || prefix > (version === 4 ? 32 : 128)) {
        throw new Error(`plugins.private_hosts: ${raw} is not a CIDR range`);
      }
      ranges.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
    } else if (isIP(entry) !== 0) {
      ranges.addAddress(entry, isIP(entry) === 4 ? 'ipv4' : 'ipv6');
    } else if (isHostName(entry)) {
      names.add(entry);
    } else {
      throw new Error(
        `plugins.private_hosts: ${raw} is neither a host name, an address nor a range`,
      );
    }
  }
  return { names, ranges };
}

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Whether a plugin may connect to `address`: public, or in a listed range. */
export function reachable(address: string, hosts: PrivateHosts): boolean {
  if (isPublicAddress(address)) return true;
  const bare = MAPPED_IPV4.exec(address)?.[1] ?? address;
  const version = isIP(bare);
  if (version === 0) return false;
  return hosts.ranges.check(bare, version === 4 ? 'ipv4' : 'ipv6');
}
