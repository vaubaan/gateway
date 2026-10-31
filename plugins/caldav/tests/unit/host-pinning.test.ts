/**
 * Where the app password may go (security audit 2026-10-31, L3) : the host the
 * person typed, and the one host of the calendar home the principal announced at
 * discovery — never another sibling of the server named later by an answer.
 */
import { describe, expect, test } from 'vitest';

import type { McpToolResult } from '@vaubaan/plugin-sdk';

import { caldavPlugin } from '../../src/index.ts';
import { isAllowedTarget, isHomeHost, pinnedTo, type DavAccount } from '../../src/dav.ts';
import { TOOL } from '../../src/identity.ts';
import { icloudLike, PASSWORD, USER } from './fake-caldav.ts';
import { connCtx, execCtx } from './fixtures.ts';

const ICLOUD: DavAccount = {
  server: new URL('https://caldav.icloud.com/'),
  username: USER,
  password: PASSWORD,
};
const HOME = new URL('https://p42-caldav.icloud.com/123456789/calendars/');

describe('the hosts of an account', () => {
  test('the server host only, until a home is pinned ; then that home and no other sibling', () => {
    const at = (href: string, account: DavAccount): boolean =>
      isAllowedTarget(new URL(href), account);
    expect(at('https://caldav.icloud.com/123456789/principal/', ICLOUD)).toBe(true);
    expect(at('https://p42-caldav.icloud.com/123456789/calendars/', ICLOUD)).toBe(false);
    const pinned = pinnedTo(ICLOUD, HOME);
    expect(at('https://p42-caldav.icloud.com/123456789/calendars/home/', pinned)).toBe(true);
    expect(at('https://caldav.icloud.com/123456789/principal/', pinned)).toBe(true);
    expect(at('https://p43-caldav.icloud.com/123456789/calendars/home/', pinned)).toBe(false);
    expect(at('http://p42-caldav.icloud.com/123456789/calendars/', pinned)).toBe(false);
  });

  test('a home may be announced on a sibling of the server, never above a two-label parent', () => {
    const server = new URL('https://caldav.icloud.com/');
    expect(isHomeHost(new URL('https://p42-caldav.icloud.com/x/'), server)).toBe(true);
    expect(isHomeHost(new URL('https://icloud.com.evil.example/x/'), server)).toBe(false);
    expect(isHomeHost(new URL('https://www.example.com/x/'), new URL('https://example.com/'))).toBe(
      false,
    );
    expect(isHomeHost(new URL('https://p42-caldav.icloud.com:8443/x/'), server)).toBe(false);
  });
});

describe('discovery and calls stay on the pinned home', () => {
  test('a calendar the home lists on another sibling host is not a resource, and nothing is sent there', async () => {
    const server = icloudLike();
    const serve = server.asFetch();
    // The home's listing names one calendar on another host of the parent domain.
    const fetchWithStranger: typeof fetch = async (input, init) => {
      const response = await serve(input, init);
      if (init?.method !== 'PROPFIND' || new Headers(init.headers).get('depth') !== '1') {
        return response;
      }
      const body = (await response.text()).replace(
        '<D:href>/123456789/calendars/home/</D:href>',
        '<D:href>https://p77-caldav.icloud.com/123456789/calendars/home/</D:href>',
      );
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const resources = await caldavPlugin.discoverResources({
      ...connCtx(server),
      fetch: fetchWithStranger,
    });
    expect(resources.map((r) => r.ref)).toEqual(['8F1C2B3A-4D5E-6F70-8192-A3B4C5D6E7F8']);
    expect(new Set(server.requests.map((r) => new URL(r.url).host))).toEqual(
      new Set(['caldav.icloud.com', 'p42-caldav.icloud.com']),
    );
  });

  test('a call on a calendar of the home reaches it there', async () => {
    const server = icloudLike();
    const [calendar] = await caldavPlugin.discoverResources(connCtx(server));
    server.requests.length = 0;
    const result: McpToolResult = await caldavPlugin.execute(
      execCtx(server, [calendar!]),
      TOOL.listEvents,
      { calendar: calendar!.ref, start: '2026-10-26', end: '2026-11-02' },
    );
    expect(result.isError).toBeFalsy();
    expect(server.requests.map((r) => new URL(r.url).host)).toEqual(['p42-caldav.icloud.com']);
  });
});
