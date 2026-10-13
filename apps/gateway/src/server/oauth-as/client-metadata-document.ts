/**
 * Client ID Metadata Documents: a client whose `client_id` is the https URL of
 * a JSON document describing it (the successor of dynamic registration in the
 * MCP authorization specification, revision 2026-07-28).
 *
 * Fetching a URL chosen by a caller from inside a company network is a
 * server-side request forgery risk, so this file is deliberately narrow:
 *
 *   - the identifier must be a canonical https URL on a DNS name, default
 *     port, with a path — never an IP literal, credentials or a fragment;
 *   - the request goes to an address checked at connection time: every
 *     address the name resolves to must be public (no loopback, private,
 *     link-local, carrier-grade NAT, unique-local, multicast or documentation
 *     range), and the peer actually connected to is checked again;
 *   - no redirect is followed, the answer is capped in size and time;
 *   - only a signed-in user's authorization request triggers a fetch, behind
 *     a rate limit (`ClientRegistry`), and only when the operator enabled
 *     `oauth.client_registration.metadata_documents`.
 *
 * The document is data, never trusted for more than what a registration would
 * be: the same redirect URI rules apply, and only public clients are accepted.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { checkRedirectUri } from './redirect-uri';

export const MAX_CLIENT_ID_URL_LENGTH = 512;
/** The draft recommends a few kilobytes; a client description is never larger. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;
export const DOCUMENT_FETCH_TIMEOUT_MS = 5_000;
export const MAX_DOCUMENT_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME_LENGTH = 80;

const MIN_CACHE_SECONDS = 300;
const DEFAULT_CACHE_SECONDS = 3_600;
const MAX_CACHE_SECONDS = 86_400;
const HTTP_OK = 200;

export class ClientDocumentError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ClientDocumentError';
  }
}

/** Whether a `client_id` claims to be a metadata document URL. */
export function isClientIdUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/**
 * The URL of a metadata document, or the reason the identifier cannot be one.
 * The string must already be in canonical form (`new URL(raw).href === raw`),
 * which rules out dot segments, upper-case hosts and default ports written
 * out: one client has one identifier.
 */
export function checkClientIdUrl(raw: string): URL | { readonly reason: string } {
  if (raw.length > MAX_CLIENT_ID_URL_LENGTH) {
    return { reason: `is longer than ${MAX_CLIENT_ID_URL_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'is not a URL' };
  }
  if (url.protocol !== 'https:') return { reason: 'must use https' };
  if (url.href !== raw) return { reason: 'is not in canonical form' };
  if (url.username !== '' || url.password !== '') return { reason: 'must not carry credentials' };
  if (url.hash !== '' || raw.includes('#')) return { reason: 'must not contain a fragment' };
  if (url.port !== '') return { reason: 'must use the default https port' };
  if (url.pathname === '/' || url.pathname === '') return { reason: 'must contain a path' };
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return { reason: 'must name a host, not an IP address' };
  }
  if (!url.hostname.includes('.')) return { reason: 'must name a fully qualified host' };
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Address filter
// ─────────────────────────────────────────────────────────────────────────────

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

type Resolver = (hostname: string) => Promise<readonly LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * A `lookup` for `net.connect` that resolves the name once and hands the
 * socket only public addresses: if any address of the name is not public the
 * whole lookup fails, so a name with one public and one private record cannot
 * be used to reach the private one.
 */
export function publicOnlyLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
          callback(new ClientDocumentError('the host does not resolve to a public address'), '');
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

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchedDocument {
  readonly status: number;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
  readonly body: string;
}

/** Fetches the document of a checked client id URL. Tests inject a fake. */
export type ClientDocumentFetcher = (url: URL) => Promise<FetchedDocument>;

function header(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The production fetcher: one GET over https, public addresses only, no
 * redirect followed (a 3xx is returned as is and refused by the parser), a
 * deadline for the whole exchange and a cap on the body.
 */
export function createClientDocumentFetcher(
  options: { readonly resolve?: Resolver; readonly timeoutMs?: number } = {},
): ClientDocumentFetcher {
  const lookup = publicOnlyLookup(options.resolve);
  const timeoutMs = options.timeoutMs ?? DOCUMENT_FETCH_TIMEOUT_MS;
  return (url) =>
    new Promise<FetchedDocument>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          lookup,
          // One connection per document: nothing is pooled or reused.
          agent: false,
          headers: { Accept: 'application/json', 'User-Agent': 'vaubaan-gateway' },
        },
        (res) => {
          const peer = res.socket.remoteAddress;
          if (!peer || !isPublicAddress(peer)) {
            req.destroy(new ClientDocumentError('the host does not resolve to a public address'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_DOCUMENT_BYTES) {
              req.destroy(
                new ClientDocumentError(`the document is larger than ${MAX_DOCUMENT_BYTES} bytes`),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            clearTimeout(deadline);
            resolve({
              status: res.statusCode ?? 0,
              contentType: header(res.headers['content-type']),
              cacheControl: header(res.headers['cache-control']),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );
      const deadline = setTimeout(() => {
        req.destroy(new ClientDocumentError('the document was not received in time'));
      }, timeoutMs);
      req.on('error', (err) => {
        clearTimeout(deadline);
        reject(err);
      });
      req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientDocument {
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly clientUri: string | null;
  /** How long the document may be reused before it is fetched again. */
  readonly maxAgeSeconds: number;
}

/**
 * C0 and C1 controls, zero-width characters and bidirectional overrides: none may reach
 * a consent screen, where they could hide or reorder what the user reads.
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Printable, single-line, bounded: what a consent screen may show of a client's name. */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_CLIENT_NAME_LENGTH);
}

/** A home page a consent screen may link to: https only, or nothing. */
export function cleanClientUri(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_CLIENT_ID_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function maxAgeOf(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_CACHE_SECONDS;
  if (/\bno-(?:store|cache)\b/i.test(cacheControl)) return MIN_CACHE_SECONDS;
  const match = /\bmax-age\s*=\s*(\d{1,9})\b/i.exec(cacheControl);
  if (!match) return DEFAULT_CACHE_SECONDS;
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, Number(match[1])));
}

/**
 * Validates what was fetched for `clientId`. The document must name itself
 * exactly, describe a public client, and list redirect URIs a registration
 * would accept.
 */
export function parseClientDocument(clientId: URL, fetched: FetchedDocument): ClientDocument {
  if (fetched.status !== HTTP_OK) {
    throw new ClientDocumentError(`the document answered HTTP ${fetched.status}`);
  }
  if (!fetched.contentType || !/\bjson\b/i.test(fetched.contentType)) {
    throw new ClientDocumentError('the document is not served as JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body) as unknown;
  } catch {
    throw new ClientDocumentError('the document is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClientDocumentError('the document is not a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.client_id !== clientId.href) {
    throw new ClientDocumentError('the document names another client_id than its own URL');
  }
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    throw new ClientDocumentError('the document must not carry a client secret');
  }
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    throw new ClientDocumentError(
      'only public clients (token_endpoint_auth_method "none") are accepted',
    );
  }
  const name = cleanClientName(doc.client_name);
  if (!name) throw new ClientDocumentError('the document has no client_name');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_DOCUMENT_REDIRECT_URIS) {
    throw new ClientDocumentError(
      `the document must list between 1 and ${MAX_DOCUMENT_REDIRECT_URIS} redirect_uris`,
    );
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    const check = checkRedirectUri(uri);
    if (!check.ok) throw new ClientDocumentError(`a redirect URI ${check.reason}`);
    redirectUris.push(uri as string);
  }
  return {
    name,
    redirectUris,
    clientUri: cleanClientUri(doc.client_uri),
    maxAgeSeconds: maxAgeOf(fetched.cacheControl),
  };
}
