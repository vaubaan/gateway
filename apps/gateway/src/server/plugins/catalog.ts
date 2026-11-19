/**
 * The catalog's archives, read by an instance (ADR plugin-catalog-rebuilt-from-source;
 * intent "Install a catalog plugin in one click").
 *
 * The catalog (`vaubaan/gateway-plugins`) publishes each version it rebuilt and signed as
 * the release `<id>-v<version>`, whose one asset is `<id>-v<version>.tgz`. An instance
 * downloads it like the versions feed: a GET carrying nothing about the instance (generic
 * `User-Agent`, no cookie), bounded in time and size. Redirects are followed — GitHub
 * serves release assets from another host — because nothing in the answer is trusted: the
 * install service keeps the archive only if its signature verifies as the catalog's and
 * names the id and version asked for.
 */

import { createHash } from 'node:crypto';

import { ARCHIVE_LIMITS } from '@vaubaan/plugin-sdk/archive';

import knownVersions from './catalog-versions.json' with { type: 'json' };

/** A catalog version this release was tested with, pinned by its archive's sha256. */
export interface KnownCatalogVersion {
  /** The service's name, as its plugin says it: what the connect picker shows before it is installed. */
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

/**
 * The catalog versions this release knows (`catalog-versions.json`, ADR
 * plugins-installed-when-first-needed): what an instance installs when the versions feed
 * names none, and at a start for the plugins its accounts need. Nothing is preinstalled.
 */
export const KNOWN_CATALOG_VERSIONS: ReadonlyMap<string, KnownCatalogVersion> = new Map(
  Object.entries((knownVersions as { plugins: Record<string, KnownCatalogVersion> }).plugins),
);

/** Where the catalog's release assets are, `<base><tag>/<tag>.tgz`. */
export const CATALOG_RELEASES_URL = new URL(
  'https://github.com/vaubaan/gateway-plugins/releases/download/',
);

/**
 * The catalog's index (ADR plugin-catalog-rebuilt-from-source, amendment 2026-11-19): its
 * plugins' names, latest versions and archive digests, published by its release workflow.
 */
export const CATALOG_INDEX_URL = new URL('https://vaubaan.github.io/gateway-plugins/index.json');

/** The `User-Agent` of the request: the product, never its version or the instance. */
export const CATALOG_USER_AGENT = 'vaubaan-gateway';

/** How long a download may take; an archive is at most a few megabytes. */
export const CATALOG_TIMEOUT_MS = 60_000;

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type CatalogFetchCode = 'not-in-catalog' | 'catalog-unreachable';

export type CatalogFetch =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly url: string }
  | { readonly ok: false; readonly code: CatalogFetchCode; readonly message: string };

/** The URL of a version's archive, or `null` for an id or a version that is not one. Pure. */
export function catalogArchiveUrl(base: URL, pluginId: string, version: string): URL | null {
  if (!PLUGIN_ID.test(pluginId) || pluginId.length > 64 || !VERSION.test(version)) return null;
  if (version.length > 64) return null;
  const tag = `${pluginId}-v${version}`;
  return new URL(`${encodeURIComponent(tag)}/${encodeURIComponent(tag)}.tgz`, base);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Downloads a version's archive from the catalog. Never throws: a failure is a result. */
export async function fetchCatalogArchive(
  pluginId: string,
  version: string,
  options: {
    readonly fetch: typeof fetch;
    readonly base?: URL;
    readonly timeoutMs?: number;
    /** The archive's sha256 when the version is pinned (`KNOWN_CATALOG_VERSIONS`). */
    readonly sha256?: string;
  },
): Promise<CatalogFetch> {
  const url = catalogArchiveUrl(options.base ?? CATALOG_RELEASES_URL, pluginId, version);
  if (url === null) {
    return {
      ok: false,
      code: 'not-in-catalog',
      message: `${pluginId} ${version} is not a catalog version`,
    };
  }
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      headers: { 'user-agent': CATALOG_USER_AGENT, accept: 'application/octet-stream' },
      // The archive is verified by its signature, never by where it came from.
      redirect: 'follow',
      credentials: 'omit',
      signal: AbortSignal.timeout(options.timeoutMs ?? CATALOG_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      code: 'catalog-unreachable',
      message: `the catalog did not answer (${url.origin}); nothing was installed`,
    };
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return {
      ok: false,
      code: 'not-in-catalog',
      message: `the catalog has published no archive of ${pluginId} ${version} yet`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      code: 'catalog-unreachable',
      message: `the catalog answered ${response.status}; nothing was installed`,
    };
  }
  const bytes = await readBounded(response, ARCHIVE_LIMITS.compressedBytes);
  if (bytes === null) {
    return {
      ok: false,
      code: 'catalog-unreachable',
      message: 'the archive is larger than any plugin may be',
    };
  }
  if (options.sha256 !== undefined) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== options.sha256) {
      return {
        ok: false,
        code: 'catalog-unreachable',
        message: `the catalog served ${pluginId} ${version} with sha256 ${digest}, this release pins ${options.sha256}; nothing was installed`,
      };
    }
  }
  return { ok: true, bytes, url: url.href };
}
