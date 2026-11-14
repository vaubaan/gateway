/**
 * `executeFly`, `discoverFlyResources` and the token check, against
 * `mockFetch` : the requests sent, the provider failures thrown, and every
 * guard of the executor declining before the request it protects.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamProtocolError, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import {
  EXEC_OUTPUT_MAX,
  FLY_LOGS_BASE,
  MAX_DISCOVERED_APPS,
  REDACTED,
  flyPlugin,
  verifyFlyToken,
} from '../../src/index.ts';
import {
  API,
  DIGEST,
  IMAGE,
  OLD_IMAGE,
  TOKEN,
  acme,
  appIdentityRoute,
  canary,
  config,
  context,
  credential,
  leaseRoutes,
  machineRoute,
} from './fixtures.ts';

const run = (
  routes: readonly MockRoute[],
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [acme],
  fields: Record<string, string> = {},
) => {
  const fetch = mockFetch(routes);
  return { fetch, result: flyPlugin.execute(context(fetch, resources, fields), tool, args) };
};

const textOf = async (promise: Promise<{ content: readonly unknown[]; isError?: boolean }>) => {
  const result = await promise;
  expect(result.isError).toBeUndefined();
  return JSON.parse((result.content[0] as { text: string }).text) as unknown;
};

const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();
const old = () => new Date(Date.now() - 3 * 3600_000).toISOString();

describe('requests', () => {
  test('a read sends the FlyV1 token and returns the answer', async () => {
    const { fetch, result } = run(
      [{ method: 'GET', url: `${API}/apps/acme-gw/machines?region=cdg`, body: [{ id: 'm1' }] }],
      TOOL.listMachines,
      { app: 'acme-gw', region: 'cdg' },
    );
    expect(await textOf(result)).toEqual([{ id: 'm1' }]);
    expect(fetch.calls[0]!.headers.authorization).toBe(TOKEN);
  });

  test('a token pasted without its scheme is sent with FlyV1', async () => {
    const { fetch, result } = run(
      [{ url: `${API}/apps/acme-gw`, body: {} }],
      TOOL.getApp,
      {},
      [acme],
      {
        api_token: 'fm2_abcdefghijklmnopqrstuvwxyz',
      },
    );
    await result;
    expect(fetch.calls[0]!.headers.authorization).toBe('FlyV1 fm2_abcdefghijklmnopqrstuvwxyz');
  });

  test('create_app forces the organization of the account', async () => {
    const { fetch, result } = run(
      [{ method: 'POST', url: `${API}/apps`, body: { id: 'new' } }],
      TOOL.createApp,
      { name: 'beta-gw', network: 'beta-net' },
      [],
    );
    await textOf(result);
    expect(fetch.calls[0]!.json).toEqual({
      name: 'beta-gw',
      network: 'beta-net',
      org_slug: 'vaubaan',
    });
  });

  test('a write first checks that the app is still the discovered one', async () => {
    const { fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'POST', url: `${API}/apps/acme-gw/machines/m1/restart`, body: {} },
      ],
      TOOL.restartMachine,
      { app: 'acme-gw', machine_id: 'm1' },
    );
    await textOf(result);
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/apps/acme-gw`,
      `POST ${API}/apps/acme-gw/machines/m1/restart`,
    ]);
  });

  test('an app recreated under the same name, or moved, is refused before the write', async () => {
    const stranger = [
      {
        method: 'GET',
        url: `${API}/apps/acme-gw`,
        body: { id: 'other-id', organization: { slug: 'vaubaan' } },
      },
    ];
    let { fetch, result } = run(stranger, TOOL.stopMachine, { app: 'acme-gw', machine_id: 'm1' });
    expect(await refusalText(result)).toMatch(/no longer the app this account discovered/);
    expect(fetch.calls).toHaveLength(1);
    const moved = [
      {
        method: 'GET',
        url: `${API}/apps/acme-gw`,
        body: { id: 'app-acme', organization: { slug: 'elsewhere' } },
      },
    ];
    ({ result } = run(moved, TOOL.stopMachine, { app: 'acme-gw', machine_id: 'm1' }));
    expect(await refusalText(result)).toMatch(/no longer the app/);
    const unrecorded = {
      ...acme,
      metadata: { org_slug: 'vaubaan', image_prefixes: 'ghcr.io/vaubaan/gateway' },
    };
    ({ fetch, result } = run([], TOOL.stopMachine, { app: 'acme-gw', machine_id: 'm1' }, [
      unrecorded,
    ]));
    expect(await refusalText(result)).toMatch(/no app id is recorded/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a provider failure is thrown : 401 / 403 as UpstreamAuthError, another status as UpstreamHttpError', async () => {
    await expect(
      run([{ url: `${API}/apps/acme-gw`, status: 401 }], TOOL.getApp, {}).result,
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    await expect(
      run([{ url: `${API}/apps/acme-gw`, status: 403 }], TOOL.getApp, {}).result,
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
    });
    await expect(
      run([{ url: `${API}/apps/acme-gw`, status: 503 }], TOOL.getApp, {}).result,
    ).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 503,
    });
  });

  test('an answer that is not JSON, or not the shape the executor reads, is an UpstreamProtocolError', async () => {
    await expect(
      run([{ url: `${API}/apps/acme-gw`, body: 'not json' }], TOOL.getApp, {}).result,
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    // The machine a config change starts from, and the lease it is written under.
    await expect(
      run(
        [appIdentityRoute(), { method: 'GET', url: `${API}/apps/acme-gw/machines/m1`, body: {} }],
        TOOL.deployImage,
        { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
      ).result,
    ).rejects.toThrow(/a machine with a config: unexpected answer/);
    await expect(
      run(
        [
          appIdentityRoute(),
          machineRoute(config(OLD_IMAGE)),
          { method: 'POST', url: (u) => u.endsWith('/lease'), body: { nonce: '' } },
        ],
        TOOL.deployImage,
        { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
      ).result,
    ).rejects.toThrow(/a lease with a nonce: unexpected answer/);
  });

  test('a success without content becomes a confirmation', async () => {
    const { result } = run(
      [
        appIdentityRoute(),
        { method: 'DELETE', url: `${API}/apps/acme-gw/machines/m1`, status: 204 },
      ],
      TOOL.destroyMachine,
      { app: 'acme-gw', machine_id: 'm1' },
    );
    expect(await textOf(result)).toEqual({ destroyed: 'm1' });
  });

  test('IPv6 addresses are encoded in the path ; certificates are asked by hostname', async () => {
    let { fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'DELETE', url: (u) => u.includes('/ip_assignments/'), status: 204 },
      ],
      TOOL.releaseIp,
      { app: 'acme-gw', ip: '2a09:8280:1::1' },
    );
    await textOf(result);
    expect(fetch.calls[1]!.url).toBe(`${API}/apps/acme-gw/ip_assignments/2a09%3A8280%3A1%3A%3A1`);
    ({ fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'POST', url: `${API}/apps/acme-gw/certificates/acme`, body: {} },
      ],
      TOOL.requestCertificate,
      { app: 'acme-gw', hostname: 'acme.example.com' },
    ));
    await textOf(result);
    expect(fetch.calls[1]!.json).toEqual({ hostname: 'acme.example.com' });
  });

  test('logs are read from the logs endpoint with the filters', async () => {
    const { fetch, result } = run(
      [
        {
          method: 'GET',
          url: (u) => u.startsWith(`${FLY_LOGS_BASE}/apps/acme-gw/logs`),
          body: { data: [] },
        },
      ],
      TOOL.getLogs,
      { app: 'acme-gw', machine_id: 'm1', next_token: '17' },
    );
    await textOf(result);
    expect(fetch.calls[0]!.url).toBe(
      `${FLY_LOGS_BASE}/apps/acme-gw/logs?instance=m1&next_token=17`,
    );
    expect(fetch.calls[0]!.headers.authorization).toBe(TOKEN);
  });

  test('an undeclared argument is refused by execute too, before any request', async () => {
    const { fetch, result } = run([], TOOL.listSecrets, { app: 'acme-gw', show_secrets: true });
    expect(await refusalText(result)).toMatch(/^show_secrets: not an argument/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('list_apps answers the apps of the mission only', () => {
  test('other apps of the organization are left out', async () => {
    const { fetch, result } = run(
      [
        {
          method: 'GET',
          url: (u) => u.startsWith(`${API}/apps?`),
          body: {
            apps: [
              { id: 'app-acme', name: 'acme-gw' },
              { id: 'app-z', name: 'zeta-gw' },
            ],
          },
        },
      ],
      TOOL.listApps,
      {},
    );
    expect(await textOf(result)).toEqual({ apps: [{ id: 'app-acme', name: 'acme-gw' }] });
    expect(fetch.calls[0]!.url).toBe(`${API}/apps?org_slug=vaubaan&limit=500`);
  });
});

describe('secrets never come back', () => {
  test('values in a list answer are redacted, names and digests kept', async () => {
    const { result } = run(
      [
        {
          url: `${API}/apps/acme-gw/secrets`,
          body: {
            secrets: [
              { name: 'KEY', digest: 'd1', value: 'plain', created_at: 't', extra: 'x', empty: '' },
            ],
          },
        },
      ],
      TOOL.listSecrets,
      {},
    );
    expect(await textOf(result)).toEqual({
      secrets: [
        { name: 'KEY', digest: 'd1', value: REDACTED, created_at: 't', extra: REDACTED, empty: '' },
      ],
    });
  });

  test('set_secrets sends the values and redacts what comes back', async () => {
    const { fetch, result } = run(
      [
        appIdentityRoute(),
        {
          method: 'POST',
          url: `${API}/apps/acme-gw/secrets`,
          body: { version: 3, secrets: [{ name: 'KEY', value: 'plain' }], unexpected: 'leak' },
        },
      ],
      TOOL.setSecrets,
      { values: { KEY: 'plain' } },
    );
    expect(await textOf(result)).toEqual({
      version: 3,
      secrets: [{ name: 'KEY', value: REDACTED }],
      unexpected: REDACTED,
    });
    expect(fetch.calls[1]!.json).toEqual({ values: { KEY: 'plain' } });
  });

  test('unset_secret deletes by name', async () => {
    const { fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'DELETE', url: `${API}/apps/acme-gw/secrets/KEY`, body: { version: 4 } },
      ],
      TOOL.unsetSecret,
      { name: 'KEY' },
    );
    expect(await textOf(result)).toEqual({ version: 4 });
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('image changes', () => {
  const snapshotsRoute = (createdAt: string, status = 'created'): MockRoute => ({
    method: 'GET',
    url: `${API}/apps/acme-gw/volumes/vol_1/snapshots`,
    body: [{ id: 'vs_1', created_at: createdAt, status }],
  });
  const update: MockRoute = {
    method: 'POST',
    url: `${API}/apps/acme-gw/machines/m1`,
    respond: (call) => ({ id: 'm1', config: (call.json as { config: unknown }).config }),
  };
  const mounted = config(OLD_IMAGE, [{ volume: 'vol_1', path: '/data' }]);

  test('deploy_image changes the image only, under a lease, after a fresh snapshot', async () => {
    const { fetch, result } = run(
      [appIdentityRoute(), machineRoute(mounted), snapshotsRoute(recent()), ...leaseRoutes, update],
      TOOL.deployImage,
      { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
    );
    await textOf(result);
    const post = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/machines/m1'))!;
    expect(post.json).toEqual({ config: { ...mounted, image: IMAGE }, current_version: 'v1' });
    expect(post.headers['fly-machine-lease-nonce']).toBe('n-1');
    expect(fetch.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${API}/apps/acme-gw/machines/m1/lease`,
    });
  });

  test('without a snapshot of the last hour, or with one still running, the image does not change', async () => {
    for (const route of [snapshotsRoute(old()), snapshotsRoute(recent(), 'running')]) {
      const { fetch, result } = run(
        [appIdentityRoute(), machineRoute(mounted), route],
        TOOL.deployImage,
        { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
      );
      expect(await refusalText(result)).toMatch(
        /volume vol_1: no snapshot created in the last 60 minutes/,
      );
      expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  test('a machine without volumes needs no snapshot', async () => {
    const { result } = run(
      [appIdentityRoute(), machineRoute(config(OLD_IMAGE)), ...leaseRoutes, update],
      TOOL.deployImage,
      { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
    );
    await textOf(result);
  });

  test('the image guard holds in execute, from the account prefixes', async () => {
    const other = `ghcr.io/acme/app@sha256:${DIGEST}`;
    const wider = {
      ...acme,
      metadata: { ...acme.metadata, image_prefixes: 'ghcr.io/vaubaan/gateway,ghcr.io/acme/app' },
    };
    // The resource says the image is allowed ; the account's field does not.
    const { fetch, result } = run(
      [appIdentityRoute([wider]), machineRoute(config(OLD_IMAGE))],
      TOOL.deployImage,
      { app: 'acme-gw', machine_id: 'm1', image: other },
      [wider],
    );
    expect(await refusalText(result)).toMatch(/is not an image this account may run/);
    expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
    const create = run(
      [appIdentityRoute([wider])],
      TOOL.createMachine,
      { app: 'acme-gw', config: config(other), region: 'cdg' },
      [wider],
    );
    expect(await refusalText(create.result)).toMatch(/is not an image this account may run/);
  });

  test('update_machine with a new image checks the snapshots ; with the same image it does not', async () => {
    const refused = run(
      [appIdentityRoute(), machineRoute(mounted), snapshotsRoute(old())],
      TOOL.updateMachine,
      { app: 'acme-gw', machine_id: 'm1', config: { ...mounted, image: IMAGE } },
    );
    expect(await refusalText(refused.result)).toMatch(/no snapshot created/);
    const { fetch, result } = run(
      [appIdentityRoute(), machineRoute(mounted), update],
      TOOL.updateMachine,
      { app: 'acme-gw', machine_id: 'm1', config: { ...mounted, env: { A: '1' } } },
    );
    await textOf(result);
    expect(fetch.calls.at(-1)!.json).toEqual({
      config: { ...mounted, env: { A: '1' } },
      current_version: 'v1',
    });
  });

  test('scale_machine changes the guest only', async () => {
    const { fetch, result } = run(
      [appIdentityRoute(), machineRoute(mounted), ...leaseRoutes, update],
      TOOL.scaleMachine,
      { app: 'acme-gw', machine_id: 'm1', cpu_kind: 'performance', cpus: 2, memory_mb: 4096 },
    );
    await textOf(result);
    const post = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/machines/m1'))!;
    expect((post.json as { config: unknown }).config).toEqual({
      ...mounted,
      guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 },
    });
  });

  test('the lease is released even when the update fails', async () => {
    const { fetch, result } = run(
      [
        appIdentityRoute(),
        machineRoute(config(OLD_IMAGE)),
        ...leaseRoutes,
        { method: 'POST', url: `${API}/apps/acme-gw/machines/m1`, status: 409 },
      ],
      TOOL.deployImage,
      { app: 'acme-gw', machine_id: 'm1', image: IMAGE },
    );
    await expect(result).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 409 });
    expect(fetch.calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });
});

describe('volume restore reads from the same app only', () => {
  const create = {
    method: 'POST',
    url: `${API}/apps/acme-gw/volumes`,
    body: { id: 'vol_new' },
  } as const;

  test('a source volume of the app is accepted ; one Fly does not find under the app is refused', async () => {
    let { fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'GET', url: `${API}/apps/acme-gw/volumes/vol_2`, body: { id: 'vol_2' } },
        create,
      ],
      TOOL.createVolume,
      { name: 'data', region: 'cdg', size_gb: 1, source_volume_id: 'vol_2' },
    );
    await textOf(result);
    expect(fetch.calls.at(-1)!.json).toEqual({
      name: 'data',
      region: 'cdg',
      size_gb: 1,
      source_volume_id: 'vol_2',
    });
    ({ fetch, result } = run(
      [
        appIdentityRoute(),
        { method: 'GET', url: `${API}/apps/acme-gw/volumes/vol_x`, status: 404 },
      ],
      TOOL.createVolume,
      { name: 'data', region: 'cdg', size_gb: 1, source_volume_id: 'vol_x' },
    ));
    expect(await refusalText(result)).toMatch(/vol_x is not a volume of app 'acme-gw'/);
    expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a snapshot must be listed under a volume of the app', async () => {
    const volumes = {
      method: 'GET',
      url: `${API}/apps/acme-gw/volumes`,
      body: [{ id: 'vol_1' }],
    } as const;
    const snaps = {
      method: 'GET',
      url: `${API}/apps/acme-gw/volumes/vol_1/snapshots`,
      body: [{ id: 'vs_1' }],
    } as const;
    const accepted = run([appIdentityRoute(), volumes, snaps, create], TOOL.createVolume, {
      name: 'data',
      region: 'cdg',
      size_gb: 1,
      snapshot_id: 'vs_1',
    });
    await textOf(accepted.result);
    const { fetch, result } = run([appIdentityRoute(), volumes, snaps], TOOL.createVolume, {
      name: 'data',
      region: 'cdg',
      size_gb: 1,
      snapshot_id: 'vs_of_another_app',
    });
    expect(await refusalText(result)).toMatch(/is not a snapshot of a volume of app 'acme-gw'/);
    expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('exec', () => {
  test('sends the command with a bounded timeout and cuts long output', async () => {
    const { fetch, result } = run(
      [
        appIdentityRoute(),
        {
          method: 'POST',
          url: `${API}/apps/acme-gw/machines/m1/exec`,
          body: { stdout: 'x'.repeat(EXEC_OUTPUT_MAX + 10), stderr: '', exit_code: 0 },
        },
      ],
      TOOL.execMachine,
      { app: 'acme-gw', machine_id: 'm1', command: ['cat', '/data/log'] },
    );
    const answer = (await textOf(result)) as { stdout: string; exit_code: number };
    expect(fetch.calls[1]!.json).toEqual({ command: ['cat', '/data/log'], timeout: 60 });
    expect(answer.stdout).toMatch(/\[output cut at 65536 characters\]$/);
    expect(answer.exit_code).toBe(0);
  });
});

describe('discoverResources', () => {
  test('one resource per app, with the identity and the allowed images recorded', async () => {
    const fetch = mockFetch([
      {
        url: `${API}/apps?org_slug=vaubaan&limit=500`,
        body: {
          apps: [
            {
              id: 'app-acme',
              name: 'acme-gw',
              network: 'acme-net',
              organization: { slug: 'vaubaan' },
            },
          ],
          next_cursor: 'c2',
        },
      },
      {
        url: `${API}/apps?org_slug=vaubaan&limit=500&cursor=c2`,
        body: { apps: [{ id: 'app-b', name: 'beta-gw' }] },
      },
    ]);
    expect(
      await flyPlugin.discoverResources(
        context(fetch, [], { image_prefixes: 'ghcr.io/vaubaan/gateway, registry.fly.io/' }),
      ),
    ).toEqual([
      {
        provider: 'fly',
        ref: 'acme-gw',
        displayName: 'acme-gw',
        metadata: {
          app_id: 'app-acme',
          org_slug: 'vaubaan',
          network: 'acme-net',
          image_prefixes: 'ghcr.io/vaubaan/gateway,registry.fly.io/',
        },
      },
      {
        provider: 'fly',
        ref: 'beta-gw',
        displayName: 'beta-gw',
        metadata: {
          app_id: 'app-b',
          org_slug: 'vaubaan',
          network: '',
          image_prefixes: 'ghcr.io/vaubaan/gateway,registry.fly.io/',
        },
      },
    ]);
  });

  test('stops at the ceiling', async () => {
    const page = Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, name: `app-${i}` }));
    const fetch = mockFetch([
      { url: (u) => u.startsWith(`${API}/apps?`), body: { apps: page, next_cursor: 'more' } },
    ]);
    const found = await flyPlugin.discoverResources(context(fetch, []));
    expect(found).toHaveLength(MAX_DISCOVERED_APPS);
    expect(fetch.calls).toHaveLength(MAX_DISCOVERED_APPS / 500);
  });

  test('refuses an unexpected payload, a name no call could use, an app of another organization', async () => {
    const answer = (body: unknown) =>
      mockFetch([{ url: (u) => u.startsWith(`${API}/apps?`), body }]);
    const unexpected = flyPlugin.discoverResources(context(answer([{ id: 'x' }]), []));
    await expect(unexpected).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(unexpected).rejects.toThrow(/GET \/apps: .* unexpected answer/);
    await expect(
      flyPlugin.discoverResources(context(answer({ apps: [{ id: 'x', name: 'A/..' }] }), [])),
    ).rejects.toThrow(/not a Fly app name/);
    await expect(
      flyPlugin.discoverResources(
        context(answer({ apps: [{ id: 'x', name: 'x', organization: { slug: 'other' } }] }), []),
      ),
    ).rejects.toThrow(/not in the organization/);
    await expect(
      flyPlugin.discoverResources(
        context(answer({ apps: [] }), [], { image_prefixes: 'ghcr.io/*' }),
      ),
    ).rejects.toThrow(/allowed images/);
  });
});

describe('the token check at paste', () => {
  const verify = (body: unknown, status = 200, fields: Record<string, string> = {}) => {
    const fetch = mockFetch([{ url: `${API}/tokens/current`, status, body }]);
    return verifyFlyToken({ credential: credential(fields), fetch });
  };

  test('a token of the named organization is accepted and shown as that organization', async () => {
    expect(await verify({ tokens: [{ org_slug: 'vaubaan', organization: 'Vaubaan' }] })).toEqual({
      account: 'the Vaubaan organization',
      expiresAt: null,
    });
    expect(await verify({ tokens: [{ org_slug: 'vaubaan', apps: ['a', 'b'] }] })).toEqual({
      account: 'the vaubaan organization (2 apps only)',
      expiresAt: null,
    });
  });

  test('a token of another organization, of several, or that Fly refuses is refused', async () => {
    // The plugin's own sentence, which the connect page shows (CredentialRefusal).
    await expect(verify({ tokens: [{ org_slug: 'other' }] })).rejects.toMatchObject({
      name: 'CredentialRefusal',
      upstreamStatus: 401,
    });
    await expect(
      verify({ tokens: [{ org_slug: 'vaubaan' }, { org_slug: 'other' }] }),
    ).rejects.toThrow(/not limited/);
    await expect(verify({ tokens: [] })).rejects.toThrow(/did not describe the token/);
    await expect(verify({}, 401)).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    await expect(verify({}, 500)).rejects.toMatchObject({ name: 'UpstreamHttpError' });
    await expect(verify('not json')).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('malformed image prefixes are refused before asking Fly', async () => {
    await expect(
      verify({ tokens: [{ org_slug: 'vaubaan' }] }, 200, { image_prefixes: 'nginx:*' }),
    ).rejects.toThrow(/must list repository prefixes/);
  });

  test('the credential declares the token, the organization and the images', () => {
    expect(flyPlugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [
        { name: 'api_token', secret: true },
        { name: 'org_slug', secret: false },
        { name: 'image_prefixes', secret: false, required: false },
      ],
    });
    const field = flyPlugin.credential.kind === 'api-key' ? flyPlugin.credential.fields[0]! : null;
    const pattern = new RegExp(field!.pattern!);
    expect(pattern.test(TOKEN)).toBe(true);
    expect(pattern.test('fm2_abcdefghijklmnopqrstuvwxyz,fm1_abcdefghijklmnopqrstuvwxyz')).toBe(
      true,
    );
    expect(pattern.test('Bearer abcdef')).toBe(false);
  });
});

describe('the mission scope', () => {
  test('an app of the account outside the mission is never touched', async () => {
    const { fetch, result } = run([], TOOL.getApp, { app: 'canary-gw' });
    expect(await refusalText(result)).toBe("app 'canary-gw' is not an app of this mission");
    expect(fetch.calls).toHaveLength(0);
    const two = run([], TOOL.getApp, {}, [acme, canary]);
    expect(await refusalText(two.result)).toMatch(/name one/);
  });
});
