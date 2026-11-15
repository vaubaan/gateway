/**
 * Discovery of the `asana` plugin against `mockFetch` : workspaces from
 * `/users/me`, the projects of each, page by page, the ceiling, and the
 * payloads it must refuse.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { SERVICE_ID } from '../../src/identity.ts';
import { MAX_PROJECTS, asanaPlugin } from '../../src/index.ts';
import { WORKSPACE, api, ctx } from './fixtures.ts';

const SECOND_WORKSPACE = '1100000000000002';

const me = (workspaces: unknown): MockRoute => ({
  method: 'GET',
  url: (u) => new URL(u).pathname === '/api/1.0/users/me',
  body: { data: { gid: '1', workspaces } },
});

const projects = (workspace: string, pages: readonly unknown[][]): MockRoute[] =>
  pages.map((data, i) => ({
    method: 'GET',
    url: (u: string) => {
      const url = new URL(u);
      const offset = url.searchParams.get('offset');
      return (
        url.pathname === `/api/1.0/workspaces/${workspace}/projects` &&
        (i === 0 ? offset === null : offset === `page.${i}`)
      );
    },
    body: { data, next_page: i + 1 < pages.length ? { offset: `page.${i + 1}` } : null },
  }));

describe('discoverAsanaResources', () => {
  test('one resource per project, every workspace, every page', async () => {
    const fetch = mockFetch([
      me([
        { gid: WORKSPACE, name: 'Acme' },
        { gid: SECOND_WORKSPACE, name: 'Side' },
      ]),
      ...projects(WORKSPACE, [
        [{ gid: '1200000000000001', name: 'Roadmap', team: { name: 'Engineering' } }],
        [{ gid: '1200000000000002', name: 'Hiring', archived: false }],
      ]),
      ...projects(SECOND_WORKSPACE, [[{ gid: '1200000000000009', name: 'Garden' }]]),
    ]);
    expect(await asanaPlugin.discoverResources(ctx(fetch))).toEqual([
      {
        service: SERVICE_ID,
        ref: '1200000000000001',
        displayName: 'Engineering / Roadmap',
        metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme', team_name: 'Engineering' },
      },
      {
        service: SERVICE_ID,
        ref: '1200000000000002',
        displayName: 'Acme / Hiring',
        metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme' },
      },
      {
        service: SERVICE_ID,
        ref: '1200000000000009',
        displayName: 'Side / Garden',
        metadata: { workspace_gid: SECOND_WORKSPACE, workspace_name: 'Side' },
      },
    ]);
    const first = new URL(fetch.calls[1]!.url).searchParams;
    expect(Object.fromEntries(first)).toMatchObject({ archived: 'false', limit: '100' });
    expect(fetch.calls[0]!.url).toBe(`${api('/users/me')}?opt_fields=workspaces.name`);
  });

  test('an archived project that slips through is left out', async () => {
    const fetch = mockFetch([
      me([{ gid: WORKSPACE, name: 'Acme' }]),
      ...projects(WORKSPACE, [[{ gid: '1200000000000001', name: 'Old', archived: true }]]),
    ]);
    expect(await asanaPlugin.discoverResources(ctx(fetch))).toEqual([]);
  });

  test(`more than ${MAX_PROJECTS} projects fail the discovery`, async () => {
    const page = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        gid: String(1200000000000000 + start + i),
        name: 'p',
      }));
    const fetch = mockFetch([
      me([{ gid: WORKSPACE, name: 'Acme' }]),
      ...projects(WORKSPACE, [0, 100, 200, 300, 400, 500].map(page)),
    ]);
    await expect(asanaPlugin.discoverResources(ctx(fetch))).rejects.toThrow(
      `more than ${MAX_PROJECTS} projects`,
    );
  });

  test('a payload discovery does not recognise is a protocol failure', async () => {
    const cases: MockRoute[][] = [
      [me('not a list')],
      [me([{ gid: '../1', name: 'x' }])],
      [me([{ gid: WORKSPACE }]), ...projects(WORKSPACE, [[{ gid: 'a/b', name: 'x' }]])],
      [
        me([{ gid: WORKSPACE }]),
        {
          method: 'GET',
          url: /\/projects\?/,
          body: { data: [], next_page: { offset: 'a/b' } },
        },
      ],
      [{ method: 'GET', url: /\/users\/me/, body: { workspaces: [] } }],
    ];
    for (const routes of cases) {
      await expect(asanaPlugin.discoverResources(ctx(mockFetch(routes)))).rejects.toMatchObject({
        name: 'UpstreamProtocolError',
      });
    }
  });
});
