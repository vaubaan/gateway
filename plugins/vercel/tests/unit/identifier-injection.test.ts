/**
 * Identifiers that reach a request path : what `classify` names is what
 * `execute` sends, or the call is refused by both.
 *
 * `encodeURIComponent` leaves `.` and `..` untouched and every URL parser
 * removes dot segments, so `DELETE …/domains/..` is sent as
 * `DELETE …/projects/{id}/`. Each identifier kind therefore has one grammar
 * (`pathIdent`, `domainName`, `readDeploymentTargets`), shared by the
 * classifier and the executor. A refused value costs no network call.
 */
import { describe, expect, test } from 'vitest';
import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyVercel } from '../../src/classify.ts';
import { vercelPlugin, VERCEL_API_BASE } from '../../src/index.ts';
import {
  app,
  credential,
  ctx,
  deploymentRoute,
  forwardedArgs,
  isMcpCall,
  mcpRoute,
  TEAM,
} from './fixtures.ts';

/** Values no identifier position may let through. */
const HOSTILE: ReadonlyArray<readonly [label: string, value: string]> = [
  ['a double dot', '..'],
  ['a single dot', '.'],
  ['a dot segment inside', 'a/../b'],
  ['a separator', 'a/b'],
  ['an encoded double dot', '%2e%2e'],
  ['an encoded separator', '%2f'],
  ['a double dot and an encoded separator', '..%2f'],
  ['an empty string', ''],
  ['a 5000-character value', 'x'.repeat(5000)],
  ['a newline', 'a\nb'],
  ['a query and a fragment', 'a?x=1#y'],
  ['a backslash', 'a\\b'],
];

function slicesOf(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [app],
): string[] {
  const out = classifyVercel(tool, args, resources);
  if ('denied' in out) throw new Error(`unexpected denial: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

function isDenied(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [app],
): boolean {
  return 'denied' in classifyVercel(tool, args, resources);
}

/** `execute` declines the call itself and no request leaves. */
async function expectRefusedWithoutCall(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [app],
): Promise<void> {
  const fetch = mockFetch([]);
  const result = await vercelPlugin.execute(ctx(fetch, resources), tool, args);
  expect(result.isError).toBe(true);
  expect(fetch.calls).toHaveLength(0);
}

/** Every identifier an argument places in a request path (or, for `name`, next to one). */
const POSITIONS: ReadonlyArray<{
  position: string;
  tool: string;
  args: (value: string) => Record<string, unknown>;
}> = [
  { position: 'delete_env_var id', tool: 'vercel__delete_env_var', args: (id) => ({ id }) },
  {
    position: 'verify_project_domain domain',
    tool: 'vercel__verify_project_domain',
    args: (domain) => ({ domain }),
  },
  {
    position: 'remove_project_domain domain',
    tool: 'vercel__remove_project_domain',
    args: (domain) => ({ domain }),
  },
  {
    position: 'add_project_domain name (request body)',
    tool: 'vercel__add_project_domain',
    args: (name) => ({ name }),
  },
  {
    position: 'projectId of a REST tool',
    tool: 'vercel__list_env_vars',
    args: (projectId) => ({ projectId }),
  },
  {
    position: 'projectId of a rewrapped tool',
    tool: 'vercel__get_project',
    args: (projectId) => ({ projectId }),
  },
  {
    position: 'get_deployment idOrUrl',
    tool: 'vercel__get_deployment',
    args: (idOrUrl) => ({ idOrUrl }),
  },
  {
    position: 'get_deployment_build_logs idOrUrl',
    tool: 'vercel__get_deployment_build_logs',
    args: (idOrUrl) => ({ idOrUrl }),
  },
  {
    position: 'get_runtime_logs deploymentId',
    tool: 'vercel__get_runtime_logs',
    args: (deploymentId) => ({ deploymentId }),
  },
  {
    position: 'get_access_to_vercel_url url',
    tool: 'vercel__get_access_to_vercel_url',
    args: (url) => ({ url }),
  },
  {
    position: 'web_fetch_vercel_url url',
    tool: 'vercel__web_fetch_vercel_url',
    args: (url) => ({ url }),
  },
];

const CASES = POSITIONS.flatMap((p) =>
  HOSTILE.map(([label, value]) => ({
    position: p.position,
    label,
    tool: p.tool,
    args: p.args(value),
  })),
);

describe('vercel identifiers — a value that could leave its position is refused by classify and by execute', () => {
  test.each(CASES)('$position : $label is denied by the classifier', ({ tool, args }) => {
    expect(isDenied(tool, args)).toBe(true);
  });

  test.each(CASES)(
    '$position : $label is refused by execute before any network call',
    async ({ tool, args }) => {
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test.each([
    ['vercel__delete_env_var', { id: 42 }],
    ['vercel__delete_env_var', {}],
    ['vercel__verify_project_domain', { domain: ['a.com'] }],
    ['vercel__verify_project_domain', {}],
    ['vercel__remove_project_domain', { domain: null }],
    ['vercel__add_project_domain', { name: { a: 1 } }],
    ['vercel__add_project_domain', {}],
  ] as const)(
    '%s %j : a missing or non-string identifier is refused by both',
    async (tool, args) => {
      expect(isDenied(tool, args)).toBe(true);
      await expectRefusedWithoutCall(tool, args);
    },
  );
});

describe('vercel identifiers — the dot-segment reproductions', () => {
  test('remove_project_domain `..` never becomes DELETE /v9/projects/{id}/', async () => {
    expect(classifyVercel('vercel__remove_project_domain', { domain: '..' }, [app])).toEqual({
      denied: 'domain: missing or malformed domain name',
    });
    await expectRefusedWithoutCall('vercel__remove_project_domain', { domain: '..' });
  });

  test('verify_project_domain `..` never becomes POST /v9/projects/{id}/verify', async () => {
    await expectRefusedWithoutCall('vercel__verify_project_domain', { domain: '..' });
  });

  test('delete_env_var `..` never becomes DELETE /v9/projects/{id}/env', async () => {
    expect(classifyVercel('vercel__delete_env_var', { id: '..' }, [app])).toEqual({
      denied: 'id: missing or malformed env var id',
    });
    await expectRefusedWithoutCall('vercel__delete_env_var', { id: '..' });
  });
});

describe('vercel identifiers — legitimate shapes keep working, and the request names what was classified', () => {
  test.each([
    ['www.example.com', '*'],
    ['example.com', '*'],
    ['*.example.com', '*'],
    ['xn--bcher-kva.example', '*'],
    ['a-b.c-d.example.co.uk', '*'],
    ['localhost', 'localhost'],
  ])('domain %s is classified on domain[%s] and sent as one path segment', async (domain, seg) => {
    expect(slicesOf('vercel__remove_project_domain', { domain })).toEqual([
      `vercel.project[prj_abc].domain[${seg}].W`,
    ]);
    const fetch = mockFetch([{ method: 'DELETE', url: /./, body: {} }]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__remove_project_domain', { domain });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${VERCEL_API_BASE}/v9/projects/prj_abc/domains/${domain}?teamId=${TEAM}`,
    ]);
    // What a URL parser makes of it is the same path : no segment was removed.
    expect(new URL(fetch.calls[0]!.url).pathname).toBe(`/v9/projects/prj_abc/domains/${domain}`);
  });

  test.each([
    '.com',
    'example..com',
    'example.com.',
    '-a.com',
    'a-.com',
    'a b.com',
    'exa_mple.com',
    'a.*.com',
  ])('domain %s is not a domain name : refused by both', async (domain) => {
    expect(isDenied('vercel__verify_project_domain', { domain })).toBe(true);
    await expectRefusedWithoutCall('vercel__verify_project_domain', { domain });
  });

  test('a domain longer than 253 characters is refused', async () => {
    const domain = `${'a'.repeat(60)}.`.repeat(5) + 'com';
    expect(isDenied('vercel__add_project_domain', { name: domain })).toBe(true);
    await expectRefusedWithoutCall('vercel__add_project_domain', { name: domain });
  });

  test('an env var id is classified and sent as the same single segment', async () => {
    const id = 'Ab12Cd34Ef56Gh78';
    expect(slicesOf('vercel__delete_env_var', { id })).toContain(
      `vercel.project[prj_abc].env[prod].env-var[${id}].W`,
    );
    const fetch = mockFetch([{ method: 'DELETE', url: /./, body: {} }]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__delete_env_var', { id });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${VERCEL_API_BASE}/v9/projects/prj_abc/env/${id}?teamId=${TEAM}`,
    ]);
  });

  test('a deployment id and a deployment hostname are looked up as one path segment', async () => {
    for (const key of [
      'dpl_5WJWYSyB7BpgTj3EuwF37WMRBXBtPQ2iTMJHJBJyRfd',
      'my-app-abc123.vercel.app',
    ]) {
      const fetch = mockFetch([
        deploymentRoute(key, { id: 'dpl_own', projectId: 'prj_abc', ownerId: TEAM }),
        mcpRoute,
      ]);
      const result = await vercelPlugin.execute(ctx(fetch), 'vercel__get_deployment', {
        idOrUrl: key,
      });
      expect(result.isError).toBeUndefined();
      expect(forwardedArgs(fetch.calls.find(isMcpCall)!).idOrUrl).toBe('dpl_own');
    }
    expect(slicesOf('vercel__get_deployment', { idOrUrl: 'dpl_abc' })).toEqual([
      'vercel.project[prj_abc].env[*].deployment[dpl_abc].R',
    ]);
    expect(slicesOf('vercel__get_deployment', { idOrUrl: 'my-app-abc123.vercel.app' })).toEqual([
      'vercel.project[prj_abc].env[*].deployment[*].R',
    ]);
  });
});

describe('vercel identifiers — the deployment segment is read like execute reads it', () => {
  test('a `url` that execute refuses (no scheme) is denied by the classifier too', async () => {
    expect(isDenied('vercel__get_access_to_vercel_url', { url: 'dep-foo' })).toBe(true);
    await expectRefusedWithoutCall('vercel__get_access_to_vercel_url', { url: 'dep-foo' });
  });

  test.each([
    ['vercel__list_deployments', { idOrUrl: 'dpl_foreign' }],
    ['vercel__list_toolbar_threads', { url: 'https://other.vercel.app/' }],
    ['vercel__get_project', { deploymentId: 'dpl_foreign' }],
    ['vercel__deploy_to_vercel', { url: 'https://other.vercel.app/' }],
    ['vercel__get_deployment', { idOrUrl: 'dpl_x', deploymentId: 'dpl_foreign' }],
    ['vercel__get_runtime_logs', { deploymentId: 'dpl_x', idOrUrl: 'dpl_foreign' }],
  ] as const)(
    '%s %j : a deployment argument the tool does not declare is refused, never forwarded unverified',
    async (tool, args) => {
      expect(isDenied(tool, args)).toBe(true);
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test('a required deployment argument that is missing is denied by the classifier, as by execute', async () => {
    expect(isDenied('vercel__get_deployment', {})).toBe(true);
    await expectRefusedWithoutCall('vercel__get_deployment', {});
    // Optional : `get_runtime_logs` without `deploymentId` reads the whole project.
    expect(slicesOf('vercel__get_runtime_logs', {})).toEqual([
      'vercel.project[prj_abc].env[*].deployment[*].runtime-log.R',
    ]);
  });
});

describe('vercel identifiers — values that only travel in a JSON body or a query', () => {
  test.each(HOSTILE.filter(([, value]) => value !== ''))(
    'firewall ruleId with %s : slice on [*], URL unchanged, id in the JSON body',
    async (_label, ruleId) => {
      expect(slicesOf('vercel__remove_firewall_rule', { ruleId })).toEqual([
        'vercel.project[prj_abc].firewall.firewall-rule[*].W',
      ]);
      const fetch = mockFetch([{ method: 'PATCH', url: /./, body: {} }]);
      await vercelPlugin.execute(ctx(fetch), 'vercel__remove_firewall_rule', { ruleId });
      expect(fetch.calls.map((c) => c.url)).toEqual([
        `${VERCEL_API_BASE}/v1/security/firewall/config?teamId=${TEAM}&projectId=prj_abc`,
      ]);
      expect(fetch.calls[0]!.json).toEqual({ action: 'rules.remove', id: ruleId });
    },
  );

  test('manage_ip_blocking insert ignores `id` : the slice does not name it', () => {
    expect(
      slicesOf('vercel__manage_ip_blocking', {
        operation: 'insert',
        ip: '1.2.3.4',
        id: 'ip_other',
      }),
    ).toEqual(['vercel.project[prj_abc].firewall.ip-rule[*].W']);
    expect(slicesOf('vercel__manage_ip_blocking', { operation: 'remove', id: 'ip_1' })).toEqual([
      'vercel.project[prj_abc].firewall.ip-rule[ip_1].W',
    ]);
  });

  test('an env var key that is not slice-safe is classified on [*] and sent in the body only', async () => {
    const key = 'A/../B';
    expect(slicesOf('vercel__upsert_env_var', { key, value: 'v', target: ['preview'] })).toEqual([
      'vercel.project[prj_abc].env[preview].env-var[*].W',
    ]);
    const fetch = mockFetch([{ method: 'POST', url: /./, body: {} }]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_env_var', {
      key,
      value: 'v',
      target: ['preview'],
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=${TEAM}&upsert=true`,
    ]);
  });
});

describe('vercel identifiers — a project ref that is not a path-safe identifier is never used', () => {
  const odd: Resource = { service: 'vercel', ref: 'a/b', displayName: 'odd' };
  const dotted: Resource = { service: 'vercel', ref: '..', displayName: 'dots' };

  test.each([odd, dotted])(
    'resource ref $ref : named or implied, the call is refused',
    async (res) => {
      for (const args of [{}, { projectId: res.ref }]) {
        expect(isDenied('vercel__list_env_vars', args, [res])).toBe(true);
        await expectRefusedWithoutCall('vercel__list_env_vars', args, [res]);
        expect(isDenied('vercel__get_project', args, [res])).toBe(true);
        await expectRefusedWithoutCall('vercel__get_project', args, [res]);
      }
    },
  );

  test('discovery refuses a project id that is not a path-safe identifier', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${VERCEL_API_BASE}/v2/teams/${TEAM}`, body: { id: TEAM } },
      {
        method: 'GET',
        url: (u) => u.startsWith(`${VERCEL_API_BASE}/v10/projects?`),
        body: {
          projects: [
            { id: 'prj_ok', name: 'ok' },
            { id: '../x', name: 'odd' },
          ],
        },
      },
    ]);
    await expect(vercelPlugin.discoverResources({ credential, fetch })).rejects.toThrow(
      /not a path-safe identifier/,
    );
  });
});
