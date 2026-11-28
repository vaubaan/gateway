/**
 * How the instance is reached: `public_url` (and local mode's loopback hosts),
 * `instance_name`, and the source of client addresses (`trusted_proxies`,
 * `client_ip_header`, `accept_shared_address_windows`).
 */
import { isClientIpHeader, isTrustedProxyEntry, type ClientIpHeader } from '../http/client-ip';
import { checkInstanceName, INSTANCE_NAME_PROBLEMS } from './instance-name';
import type { Reader } from './reader';
import type { EnvSource } from './secret-refs';
import { envNamesFor, isKeyRequired, keySpec } from './sources';

/** The hosts a local instance's public URL may name: this computer only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https, no query or fragment, trailing slash stripped (a sub-path is kept). In local
 * mode, a loopback host, over http or https (ADR local-mode-for-an-instance-on-this-computer).
 */
export function readPublicUrl(r: Reader, local: boolean): URL | undefined {
  const key = keySpec('public_url');
  const publicUrl = r.url(key.path, { required: isKeyRequired(key), https: !local && key.https });
  if (!publicUrl) return undefined;
  if (local && !LOOPBACK_HOSTS.has(publicUrl.hostname)) {
    r.issues.add(
      'public_url',
      `local mode answers on this computer only: expected localhost, 127.0.0.1 or [::1], got "${publicUrl.hostname}" (unset local to serve a domain name)`,
      envNamesFor('public_url'),
    );
    return undefined;
  }
  if (local && publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
    r.issues.add('public_url', 'must use http or https', envNamesFor('public_url'));
    return undefined;
  }
  if (publicUrl.search || publicUrl.hash) {
    r.issues.add(
      'public_url',
      'must not carry a query string or fragment',
      envNamesFor('public_url'),
    );
  }
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
  return publicUrl;
}

/**
 * `instance_name`: optional, trimmed, within the bounds of `checkInstanceName`.
 * An absent or blank value is not a decision: Administration decides then.
 */
export function readInstanceName(r: Reader): string | null {
  const path = 'instance_name';
  const raw = r.string(path);
  if (raw === undefined) return null;
  const check = checkInstanceName(raw);
  if (!check.ok) {
    r.issues.add(path, INSTANCE_NAME_PROBLEMS[check.problem], envNamesFor(path));
    return null;
  }
  return check.name;
}

export function readTrustedProxies(r: Reader): string[] {
  const trustedProxies = r.stringList('trusted_proxies');
  for (const entry of trustedProxies) {
    if (!isTrustedProxyEntry(entry)) {
      r.issues.add(
        'trusted_proxies',
        `"${entry}" is neither an IP address nor a CIDR block`,
        envNamesFor('trusted_proxies'),
      );
    }
  }
  return trustedProxies;
}

/**
 * `client_ip_header`: the single-value header a trusted edge writes (trusted-edge mode,
 * off by default). It replaces `X-Forwarded-For` reading, so it excludes `trusted_proxies`.
 */
export function readClientIpHeader(
  r: Reader,
  trustedProxies: readonly string[],
): ClientIpHeader | null {
  const path = 'client_ip_header';
  const raw = r.string(path);
  if (raw === undefined) return null;
  const header = raw.trim().toLowerCase();
  if (!isClientIpHeader(header)) {
    r.issues.add(path, `expected one of ${keySpec(path).oneOf.join(', ')}, got "${raw}"`, [
      ...envNamesFor(path),
    ]);
    return null;
  }
  if (trustedProxies.length > 0) {
    r.issues.add(
      path,
      'set either client_ip_header (an edge that overwrites one header) or trusted_proxies (proxies that append to X-Forwarded-For), not both',
      [...envNamesFor(path), ...envNamesFor('trusted_proxies')],
    );
    return null;
  }
  return header;
}

/**
 * In production (`NODE_ENV=production`: the image, never the demo nor a test), a
 * source of client addresses is required: without `trusted_proxies` or
 * `client_ip_header` every address-keyed window is one shared by all callers, so
 * one client can hold everybody's sign-in and approval links at 429 (threat model
 * A2). `accept_shared_address_windows` states that choice instead.
 */
export function requireAddressSource(
  r: Reader,
  env: EnvSource,
  trustedProxies: readonly string[],
  clientIpHeader: ClientIpHeader | null,
): void {
  const accepted = r.bool(keySpec('accept_shared_address_windows'));
  if (env.NODE_ENV !== 'production' || accepted) return;
  if (trustedProxies.length > 0 || clientIpHeader !== null) return;
  // A client_ip_header that was refused is already an issue of its own.
  if (r.string('client_ip_header') !== undefined) return;
  r.issues.add(
    'trusted_proxies',
    'a source of client addresses is required in production: set trusted_proxies to the address of the reverse proxy in front of the instance, or client_ip_header behind an edge that overwrites it; or set accept_shared_address_windows to share every address-keyed limit among all callers (deploy/README.md)',
    [
      ...envNamesFor('trusted_proxies'),
      ...envNamesFor('client_ip_header'),
      ...envNamesFor('accept_shared_address_windows'),
    ],
  );
}
