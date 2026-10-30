/**
 * Mandatory suite of the `caldav` plugin : the SDK kit (definition, presets,
 * catalog coverage), the credential (server URL, username, app password),
 * `verify` and `discoverResources` against the fake server in three server
 * shapes, and the presets. No network.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamAuthError, type Resource } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
} from '@vaubaan/plugin-sdk/testing';

import { caldavPlugin, createCaldavPlugin, normalizeServerUrl } from '../../src/index.ts';
import { fastmailLike, icloudLike, nextcloudLike, plainServer, USER } from './fake-caldav.ts';
import { connCtx, work } from './fixtures.ts';
import { SAMPLES } from './samples.ts';

describe('SDK kit', () => {
  test('well formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(caldavPlugin);
    assertPresetsValid(caldavPlugin);
    assertNoWildcard(caldavPlugin);
  });

  test('every tool is covered by named risks ; the fallback is never hit', () => {
    const report = assertCatalogCoverage(caldavPlugin, SAMPLES, { resources: [work] });
    expect(report.fallbackHits).toEqual([]);
    expect(report.risksUntouched).toEqual([]);
  });

  test('identity : id, name, icon, version', () => {
    expect(caldavPlugin.id).toBe('caldav');
    expect(caldavPlugin.displayName).toBe('CalDAV Calendar');
    expect(caldavPlugin.version).toBe('0.1.1');
    expect(caldavPlugin.icon).toMatch(/^M/);
    expect(Object.keys(caldavPlugin.toolTitles ?? {}).sort()).toEqual(
      caldavPlugin.tools.map((t) => t.name).sort(),
    );
  });
});

describe('presets', () => {
  const entries = (id: string): Record<string, string> =>
    Object.fromEntries(
      caldavPlugin.catalog
        .presets!.find((p) => p.id === id)!
        .entries.map((e) => [e.risk_id, e.gate ?? 'auto']),
    );

  test('read-only reads, and writes nothing', () => {
    expect(entries('read-only')).toEqual({
      'caldav.read-calendars': 'auto',
      'caldav.read-events': 'auto',
    });
  });

  test('own agenda writes events that notify nobody ; deleting asks first', () => {
    const e = entries('own-agenda');
    expect(Object.keys(e).some((id) => id.startsWith('caldav.attendees-'))).toBe(false);
    expect(e['caldav.event-delete']).toBe('approval');
  });

  test('the assistant invites colleagues and allowlisted contacts freely, anybody else after approval', () => {
    const e = entries('assistant');
    expect(e['caldav.attendees-internal']).toBe('auto');
    expect(e['caldav.attendees-allowlisted']).toBe('auto');
    expect(e['caldav.attendees-external']).toBe('approval');
    expect(e['caldav.event-delete']).toBe('approval');
    expect(e['caldav.uncategorized-write']).toBeUndefined();
  });
});

describe('credential', () => {
  test('an api-key spec with a server URL, a username and a secret app password', () => {
    const spec = caldavPlugin.credential;
    expect(spec.kind).toBe('api-key');
    if (spec.kind !== 'api-key') return;
    expect(spec.fields.map((f) => [f.name, f.secret])).toEqual([
      ['server_url', false],
      ['username', false],
      ['app_password', true],
    ]);
    expect(spec.guide?.permissions).toEqual([]);
    expect(spec.guide?.steps.join(' ')).toMatch(/caldav\.icloud\.com/);
    expect(spec.guide?.steps.join(' ')).toMatch(/Google refuses app passwords/);
    expect(typeof spec.verify).toBe('function');
  });

  test.each([
    ['https://caldav.icloud.com', 'https://caldav.icloud.com/'],
    [' https://cloud.example.org/remote.php/dav ', 'https://cloud.example.org/remote.php/dav/'],
    ['https://caldav.fastmail.com/dav/?x=1#y', 'https://caldav.fastmail.com/dav/'],
    ['http://localhost:5232', 'http://localhost:5232/'],
  ])('normalises %j', (input, url) => {
    expect(String(normalizeServerUrl(input))).toBe(url);
  });

  test.each([
    ['http://cal.example.com', /https/],
    ['ftp://cal.example.com', /https/],
    ['https://ada:secret@cal.example.com', /must not carry/],
    ['https://apidata.googleusercontent.com/caldav/v2/', /Google refuses/],
    ['https://calendar.google.com', /Google refuses/],
    ['not a url', /not a URL/],
    ['', /missing/],
  ])('refuses %j', (input, reason) => {
    expect(normalizeServerUrl(input)).toMatch(reason);
  });
});

describe('verify and discovery', () => {
  test('a plain server : the principal at /.well-known/caldav, the account its address', async () => {
    const server = plainServer();
    await expect(
      caldavPlugin.credential.kind === 'api-key' &&
        caldavPlugin.credential.verify!(connCtx(server)),
    ).resolves.toEqual({
      account: USER,
      expiresAt: null,
    });
    expect(server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'PROPFIND /.well-known/caldav',
      'PROPFIND /dav/',
      'PROPFIND /dav/principals/ada/',
    ]);
    expect(server.requests.every((r) => r.headers.authorization?.startsWith('Basic '))).toBe(true);
  });

  test('discovers the event calendars only, each with its address and empty zoning lists', async () => {
    const resources = await caldavPlugin.discoverResources(connCtx(plainServer()));
    expect(resources.map((r) => [r.ref, r.displayName])).toEqual([
      ['work', 'Work'],
      ['home', 'Home'],
    ]);
    expect(resources[0]!.metadata).toEqual({
      href: 'https://cal.example.com/dav/calendars/ada/work/',
      description: 'Team meetings',
      account_addresses: USER,
      internal_domains: [],
      allowlist_domains: [],
      allowlist_addresses: [],
    });
  });

  test('iCloud-like : the root answers, the home is on a sibling host', async () => {
    const server = icloudLike();
    const resources: readonly Resource[] = await caldavPlugin.discoverResources(connCtx(server));
    expect(resources.map((r) => r.ref)).toEqual(['home', '8F1C2B3A-4D5E-6F70-8192-A3B4C5D6E7F8']);
    expect(resources[0]!.metadata!.href).toBe(
      'https://p42-caldav.icloud.com/123456789/calendars/home/',
    );
    expect(resources[0]!.metadata!.account_addresses).toBe(`${USER} ada@icloud.com`);
  });

  test('Fastmail-like : an address in the path does not leak into the ref', async () => {
    const resources = await caldavPlugin.discoverResources(connCtx(fastmailLike()));
    expect(resources.map((r) => r.ref)).toEqual([
      'Default',
      'b5c6d7e8-0000-4000-8000-000000000001',
    ]);
  });

  test('Nextcloud-like : a typed /remote.php/dav, and a calendar whose name is not a ref gets a digest', async () => {
    const server = nextcloudLike();
    const ctx = connCtx(server, { server_url: 'https://cloud.example.org/remote.php/dav' });
    const resources = await caldavPlugin.discoverResources(ctx);
    expect(resources.map((r) => r.ref)).toEqual([
      'personal',
      expect.stringMatching(/^cal-[0-9a-f]{16}$/),
      'contact_birthdays',
    ]);
    expect(resources[1]!.displayName).toBe('Team plans');
    expect(server.requests[0]!.url).toBe('https://cloud.example.org/remote.php/dav/');
  });

  test('Nextcloud-like from the bare host : the .well-known redirect is followed', async () => {
    const server = nextcloudLike();
    const resources = await caldavPlugin.discoverResources(connCtx(server));
    expect(resources).toHaveLength(3);
    expect(server.requests.slice(0, 2).map((r) => new URL(r.url).pathname)).toEqual([
      '/.well-known/caldav',
      '/remote.php/dav/',
    ]);
  });

  test('a wrong app password is a CredentialRefusal (an UpstreamAuthError), nothing else is sent', async () => {
    const server = plainServer();
    const failing = verifyOf(connCtx(server, { app_password: 'wrong' }));
    await expect(failing).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(verifyOf(connCtx(server, { app_password: 'wrong' }))).rejects.toBeInstanceOf(
      UpstreamAuthError,
    );
    await expect(verifyOf(connCtx(server, { app_password: 'wrong' }))).rejects.toThrow(
      /refused the sign-in/,
    );
  });

  test('a server with no CalDAV account says where to look', async () => {
    const server = plainServer();
    (server.options as { wellKnown: string | null }).wellKnown = null;
    await expect(verifyOf(connCtx(server))).rejects.toThrow(/no CalDAV account answers/);
  });

  test('a redirect to another site is refused, and nothing is sent there', async () => {
    const server = plainServer();
    (server.options as { wellKnown: string | null }).wellKnown = 'https://evil.example/dav/';
    await expect(verifyOf(connCtx(server))).rejects.toThrow(/outside cal\.example\.com/);
    expect(server.requests.map((r) => new URL(r.url).host)).toEqual(['cal.example.com']);
  });

  test('a principal that points to another site is refused', async () => {
    const server = plainServer();
    (server.options as { principal: string }).principal = 'https://evil.example/principal/';
    await expect(verifyOf(connCtx(server))).rejects.toThrow(/outside/);
  });

  test('a Google URL is refused before any request', async () => {
    const server = plainServer();
    await expect(
      verifyOf(connCtx(server, { server_url: 'https://apidata.googleusercontent.com/caldav/v2/' })),
    ).rejects.toThrow(/Google refuses app passwords/);
    expect(server.requests).toEqual([]);
  });

  test('an unreachable server is a sentence, not a stack', async () => {
    const ctx = {
      ...connCtx(plainServer()),
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    };
    await expect(verifyOf(ctx)).rejects.toThrow(/could not reach cal\.example\.com/);
  });

  test('createCaldavPlugin builds the same plugin', () => {
    expect(createCaldavPlugin().catalog).toEqual(caldavPlugin.catalog);
  });
});

function verifyOf(
  ctx: Parameters<
    NonNullable<Extract<typeof caldavPlugin.credential, { kind: 'api-key' }>['verify']>
  >[0],
) {
  const spec = caldavPlugin.credential;
  if (spec.kind !== 'api-key' || !spec.verify) throw new Error('no verify');
  return spec.verify(ctx);
}
