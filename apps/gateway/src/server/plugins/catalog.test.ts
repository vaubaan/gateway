/**
 * The download of a catalog version (intent "Install a catalog plugin in one click"): the
 * URL the catalog publishes it at, a GET that carries nothing about the instance, and
 * every failure a result — a missing version, an error, a body larger than any plugin.
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_RELEASES_URL, catalogArchiveUrl, fetchCatalogArchive } from './catalog';

function answering(
  status: number,
  body: Uint8Array | string = '',
  headers: Record<string, string> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : Buffer.from(body), { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('the catalog archive of a version', () => {
  it('is the release asset <id>-v<version>.tgz of the catalog repository', () => {
    expect(catalogArchiveUrl(CATALOG_RELEASES_URL, 'notion', '0.2.0')?.href).toBe(
      'https://github.com/vaubaan/gateway-plugins/releases/download/notion-v0.2.0/notion-v0.2.0.tgz',
    );
  });

  it('is no URL for what is not an id or a version', () => {
    for (const [id, version] of [
      ['../etc', '1.0.0'],
      ['Notion', '1.0.0'],
      ['notion', '1.0'],
      ['notion', '1.0.0/../../x'],
    ] as const) {
      expect(catalogArchiveUrl(CATALOG_RELEASES_URL, id, version), `${id} ${version}`).toBeNull();
    }
  });

  it('downloads it with a generic user agent and no credentials', async () => {
    const { fetchImpl, calls } = answering(200, new Uint8Array([1, 2, 3]));
    const result = await fetchCatalogArchive('notion', '0.2.0', { fetch: fetchImpl });
    expect(result).toMatchObject({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
    const [call] = calls;
    expect(new Headers(call?.init.headers).get('user-agent')).toBe('vaubaan-gateway');
    expect(call?.init.credentials).toBe('omit');
  });

  it('says a version the catalog has not published, and a catalog that does not answer', async () => {
    expect(
      await fetchCatalogArchive('notion', '9.9.9', { fetch: answering(404).fetchImpl }),
    ).toMatchObject({ ok: false, code: 'not-in-catalog' });
    expect(
      await fetchCatalogArchive('notion', '0.2.0', { fetch: answering(503).fetchImpl }),
    ).toMatchObject({ ok: false, code: 'catalog-unreachable' });
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await fetchCatalogArchive('notion', '0.2.0', { fetch: throwing })).toMatchObject({
      ok: false,
      code: 'catalog-unreachable',
    });
  });

  it('stops reading past the largest archive a plugin may be', async () => {
    const { fetchImpl } = answering(200, '', { 'content-length': String(17 * 1024 * 1024) });
    expect(await fetchCatalogArchive('notion', '0.2.0', { fetch: fetchImpl })).toMatchObject({
      ok: false,
      code: 'catalog-unreachable',
    });
  });
});
