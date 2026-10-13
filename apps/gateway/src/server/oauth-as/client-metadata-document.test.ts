import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import {
  checkClientIdUrl,
  cleanClientName,
  cleanClientUri,
  ClientDocumentError,
  createClientDocumentFetcher,
  isClientIdUrl,
  isPublicAddress,
  MAX_CLIENT_NAME_LENGTH,
  parseClientDocument,
  publicOnlyLookup,
  type FetchedDocument,
} from './client-metadata-document';

const CLIENT_ID = 'https://agent.example.net/oauth/client.json';

function fetched(body: unknown, overrides: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    status: 200,
    contentType: 'application/json',
    cacheControl: null,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...overrides,
  };
}

const VALID = {
  client_id: CLIENT_ID,
  client_name: 'Example agent',
  redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
};

describe('client id that is a metadata document URL', () => {
  it('recognises an https identifier', () => {
    expect(isClientIdUrl(CLIENT_ID)).toBe(true);
    expect(isClientIdUrl('vbn_client_abc')).toBe(false);
    expect(isClientIdUrl('http://agent.example.net/client.json')).toBe(false);
  });

  it('accepts a canonical https URL with a path on a DNS name', () => {
    expect(checkClientIdUrl(CLIENT_ID)).toBeInstanceOf(URL);
  });

  it.each([
    ['no path', 'https://agent.example.net/'],
    ['no path at all', 'https://agent.example.net'],
    ['a fragment', 'https://agent.example.net/client.json#x'],
    ['credentials', 'https://user:secret@agent.example.net/client.json'],
    ['an explicit port', 'https://agent.example.net:8443/client.json'],
    ['the default port written out', 'https://agent.example.net:443/client.json'],
    ['dot segments', 'https://agent.example.net/a/../client.json'],
    ['an upper-case host', 'https://Agent.Example.net/client.json'],
    ['an IPv4 literal', 'https://203.0.113.10/client.json'],
    ['a loopback literal', 'https://127.0.0.1/client.json'],
    ['a decimal IPv4', 'https://2130706433/client.json'],
    ['an IPv6 literal', 'https://[2001:db8::1]/client.json'],
    ['a single-label host', 'https://intranet/client.json'],
    ['the wrong scheme', 'http://agent.example.net/client.json'],
    ['not a URL', 'agent.example.net/client.json'],
    ['an oversized URL', `https://agent.example.net/${'a'.repeat(600)}`],
  ])('refuses %s', (_case, raw) => {
    expect(checkClientIdUrl(raw)).not.toBeInstanceOf(URL);
  });
});

describe('addresses a document may be fetched from', () => {
  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('accepts the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, another address', '127.9.9.9'],
    ['this network', '0.0.0.0'],
    ['private 10/8', '10.1.2.3'],
    ['private 172.16/12', '172.16.0.1'],
    ['private 172.16/12, last', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.1'],
    ['link-local, the cloud metadata service', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['benchmarking', '198.18.0.1'],
    ['documentation', '203.0.113.7'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 unique-local', 'fd12:3456:789a::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['NAT64 of a private address', '64:ff9b::a00:1'],
    ['IPv4-compatible private', '::10.0.0.1'],
    ['IPv4-compatible loopback', '::7f00:1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
    ['IPv4-mapped loopback in hexadecimal', '::ffff:7f00:1'],
    ['a host name', 'agent.example.net'],
    ['nothing', ''],
  ])('refuses %s (%s)', (_case, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('the lookup the fetch connects through', () => {
  const resolveTo = (addresses: LookupAddress[]) => async (): Promise<LookupAddress[]> => addresses;

  function lookupOnce(
    addresses: LookupAddress[],
    all: boolean,
  ): Promise<{ err: Error | null; address: unknown }> {
    return new Promise((resolve) => {
      publicOnlyLookup(resolveTo(addresses))('agent.example.net', { all }, (err, address) => {
        resolve({ err, address });
      });
    });
  }

  it('hands the socket the public addresses of the name', async () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    expect(await lookupOnce(addresses, true)).toEqual({ err: null, address: addresses });
    expect(await lookupOnce(addresses, false)).toEqual({ err: null, address: '93.184.216.34' });
  });

  it('fails the whole lookup when any address of the name is not public', async () => {
    const mixed = [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    const { err } = await lookupOnce(mixed, true);
    expect(err).toBeInstanceOf(ClientDocumentError);
    expect(
      (await lookupOnce([{ address: '169.254.169.254', family: 4 }], false)).err,
    ).toBeInstanceOf(ClientDocumentError);
  });

  it('fails when the name resolves to nothing, and passes a resolver failure on', async () => {
    expect((await lookupOnce([], true)).err).toBeInstanceOf(ClientDocumentError);
    const failing = await new Promise<Error | null>((resolve) => {
      publicOnlyLookup(async () => {
        throw new Error('ENOTFOUND');
      })('agent.example.net', { all: true }, (err) => resolve(err));
    });
    expect(failing?.message).toBe('ENOTFOUND');
  });

  it('never opens a connection to a name that resolves to a private address', async () => {
    const fetchDocument = createClientDocumentFetcher({
      resolve: resolveTo([{ address: '127.0.0.1', family: 4 }]),
      timeoutMs: 2000,
    });
    await expect(fetchDocument(new URL(CLIENT_ID))).rejects.toBeInstanceOf(ClientDocumentError);
  });
});

describe('the document itself', () => {
  const url = new URL(CLIENT_ID);

  it('yields the name, the redirect URIs and a bounded cache lifetime', () => {
    expect(
      parseClientDocument(url, fetched({ ...VALID, client_uri: 'https://agent.example.net' })),
    ).toEqual({
      name: 'Example agent',
      redirectUris: VALID.redirect_uris,
      clientUri: 'https://agent.example.net/',
      maxAgeSeconds: 3600,
    });
  });

  it.each([
    ['max-age=600', 600],
    ['public, max-age=7200', 7200],
    ['max-age=5', 300],
    ['max-age=99999999', 86_400],
    ['no-store', 300],
    ['no-cache, max-age=7200', 300],
    ['private', 3600],
  ])('reads Cache-Control "%s" as %d seconds', (cacheControl, seconds) => {
    expect(parseClientDocument(url, fetched(VALID, { cacheControl })).maxAgeSeconds).toBe(seconds);
  });

  it.each([
    ['a redirect', fetched(VALID, { status: 302 })],
    ['a 404', fetched(VALID, { status: 404 })],
    ['an HTML answer', fetched(VALID, { contentType: 'text/html' })],
    ['no content type', fetched(VALID, { contentType: null })],
    ['invalid JSON', fetched('{not json')],
    ['a JSON array', fetched([VALID])],
    ['a JSON string', fetched('"client"')],
    ['another client_id', fetched({ ...VALID, client_id: 'https://evil.example/client.json' })],
    ['a client_id that differs by a slash', fetched({ ...VALID, client_id: `${CLIENT_ID}/` })],
    ['no client_id', fetched({ ...VALID, client_id: undefined })],
    ['a client secret', fetched({ ...VALID, client_secret: 'shh' })],
    [
      'a confidential client',
      fetched({ ...VALID, token_endpoint_auth_method: 'client_secret_basic' }),
    ],
    [
      'a signed-assertion client',
      fetched({ ...VALID, token_endpoint_auth_method: 'private_key_jwt' }),
    ],
    ['no name', fetched({ ...VALID, client_name: undefined })],
    ['a blank name', fetched({ ...VALID, client_name: '   ' })],
    ['no redirect URIs', fetched({ ...VALID, redirect_uris: [] })],
    [
      'redirect URIs that are not a list',
      fetched({ ...VALID, redirect_uris: 'http://127.0.0.1/cb' }),
    ],
    [
      'too many redirect URIs',
      fetched({
        ...VALID,
        redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1/cb${i}`),
      }),
    ],
    [
      'a plain-http redirect URI',
      fetched({ ...VALID, redirect_uris: ['http://agent.example.net/cb'] }),
    ],
    ['a javascript redirect URI', fetched({ ...VALID, redirect_uris: ['javascript:alert(1)'] })],
    ['a redirect URI that is not a string', fetched({ ...VALID, redirect_uris: [42] })],
  ])('refuses %s', (_case, document) => {
    expect(() => parseClientDocument(url, document)).toThrow(ClientDocumentError);
  });
});

describe('what a client may say of itself', () => {
  it('keeps a printable, single-line, bounded name', () => {
    expect(cleanClientName('  Claude   Code ')).toBe('Claude Code');
    expect(cleanClientName('a'.repeat(200))).toHaveLength(MAX_CLIENT_NAME_LENGTH);
  });

  it('strips control characters, zero-width characters and bidirectional overrides', () => {
    const hostile = `Trusted${String.fromCharCode(0x202e)}tnega${String.fromCharCode(0x200b)}\r\nline${String.fromCharCode(0x1b)}[31m`;
    const cleaned = cleanClientName(hostile) ?? '';
    for (const code of [0x202e, 0x200b, 0x0d, 0x0a, 0x1b]) {
      expect(cleaned).not.toContain(String.fromCharCode(code));
    }
    expect(cleaned).toBe('Trusted tnega line [31m');
  });

  it('has no name for a blank, missing or non-string value', () => {
    for (const value of ['', '   ', null, undefined, 42, { name: 'x' }]) {
      expect(cleanClientName(value)).toBeNull();
    }
  });

  it('keeps an https home page and nothing else', () => {
    expect(cleanClientUri('https://agent.example.net')).toBe('https://agent.example.net/');
    for (const value of [
      'http://agent.example.net',
      'javascript:alert(1)',
      'https://user:pass@agent.example.net',
      'not a url',
      42,
      undefined,
    ]) {
      expect(cleanClientUri(value)).toBeNull();
    }
  });
});
