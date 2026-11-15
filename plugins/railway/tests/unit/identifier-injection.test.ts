/**
 * Identifiers of the Railway plugin : what `classify` names is what `execute`
 * sends, or the call is refused by both.
 *
 * No Railway identifier reaches a URL : the rewrapped tools are forwarded as
 * JSON-RPC arguments and the variable tools pass GraphQL **variables**, the
 * document text being constant. What matters here is that `execute` reads
 * the project, the environment, the service and the deployment with the
 * classifier's own `resolveTarget`, so it never forwards an id the classifier
 * did not check, nor a project the mission does not hold.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute, refusalText } from '@vaubaan/plugin-sdk/testing';

import {
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_URL,
  classifyRailway,
  railwayPlugin,
} from '../../src/index.ts';
import { UNBOUND_ARGUMENTS } from '../../src/tools.ts';
import upstreamTools from '../../src/upstream-tools.json' with { type: 'json' };

const PROJECT = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002';
const FOREIGN_PROJECT = '00000000-0000-4000-8000-0000000000ff';
const SERVICE = '00000000-0000-4000-8000-00000000000a';
const DEPLOYMENT = '00000000-0000-4000-8000-0000000000d1';
const ENV = '00000000-0000-4000-8000-0000000000e1';
const OTHER_ENV = '00000000-0000-4000-8000-0000000000e2';
const FOREIGN_ENV = '00000000-0000-4000-8000-0000000000ef';

const project: Resource = {
  service: 'railway',
  ref: PROJECT,
  env: 'staging',
  displayName: 'api',
  metadata: {
    services: [{ id: SERVICE, name: 'api' }],
    environments: [{ id: ENV, name: 'staging' }],
  },
};
const other: Resource = {
  service: 'railway',
  ref: OTHER_PROJECT,
  env: 'prod',
  displayName: 'web',
  metadata: {
    services: [{ id: SERVICE, name: 'api' }],
    environments: [{ id: OTHER_ENV, name: 'production' }],
  },
};

const execCtx = (
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [project],
): ExecuteContext => ({
  credential: { kind: 'api-key', fields: { api_token: 'rlwy_at' }, metadata: {} },
  fetch,
  resources,
});

/** The MCP server and the GraphQL API, answering anything : a test then reads what was sent. */
const upstream: readonly MockRoute[] = [
  {
    url: RAILWAY_MCP_URL,
    respond: (c) =>
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: (c.json as { id: number }).id,
        result: { content: [{ type: 'text', text: 'ok' }] },
      })}\n\n`,
  },
  {
    url: RAILWAY_GRAPHQL_URL,
    body: {
      data: {
        variables: {},
        variableUpsert: true,
        variableCollectionUpsert: true,
        variableDelete: true,
      },
    },
  },
];

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

const base = { projectId: PROJECT, environmentId: ENV };

/** Every Railway id an argument carries, on the tools that take it. */
const ID_POSITIONS: ReadonlyArray<{
  position: string;
  tool: string;
  args: (value: unknown) => Record<string, unknown>;
}> = [
  {
    position: 'projectId (rewrapped tool)',
    tool: 'railway__list-services',
    args: (projectId) => ({ projectId }),
  },
  {
    position: 'projectId (GraphQL tool)',
    tool: 'railway__list-variables',
    args: (projectId) => ({ projectId, environmentId: ENV }),
  },
  {
    position: 'environmentId (rewrapped tool)',
    tool: 'railway__redeploy',
    args: (environmentId) => ({ projectId: PROJECT, serviceId: SERVICE, environmentId }),
  },
  {
    position: 'environmentId (accept-deploy)',
    tool: 'railway__accept-deploy',
    args: (environmentId) => ({ environmentId }),
  },
  {
    position: 'environmentId (GraphQL tool)',
    tool: 'railway__upsert-variable',
    args: (environmentId) => ({ projectId: PROJECT, environmentId, name: 'K', value: 'v' }),
  },
  {
    position: 'serviceId (rewrapped tool)',
    tool: 'railway__redeploy',
    args: (serviceId) => ({ ...base, serviceId }),
  },
  {
    position: 'serviceId (get-logs)',
    tool: 'railway__get-logs',
    args: (serviceId) => ({ ...base, serviceId }),
  },
  {
    position: 'serviceId (GraphQL tool)',
    tool: 'railway__delete-variable',
    args: (serviceId) => ({ ...base, serviceId, name: 'K' }),
  },
];

const ID_CASES = ID_POSITIONS.flatMap((p) =>
  HOSTILE.map(([label, value]) => ({
    position: p.position,
    label,
    tool: p.tool,
    args: p.args(value),
  })),
);

const NON_STRING_CASES = ID_POSITIONS.flatMap((p) =>
  ([42, null, ['x'], { id: 'x' }] as const).map((value) => ({
    position: p.position,
    label: JSON.stringify(value),
    tool: p.tool,
    args: p.args(value),
  })),
);

function isDenied(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): boolean {
  return 'denied' in classifyRailway(tool, args, resources);
}

function slicesOf(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): string[] {
  const out = classifyRailway(tool, args, resources);
  if ('denied' in out) throw new Error(`unexpected denial: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

/** `execute` declines the call itself and no request leaves. */
async function expectRefusedWithoutCall(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): Promise<void> {
  const fetch = mockFetch(upstream);
  const result = await railwayPlugin.execute(execCtx(fetch, resources), tool, args);
  expect(result.isError).toBe(true);
  expect(fetch.calls).toHaveLength(0);
}

/** The arguments or GraphQL variables of the single request `execute` made. */
async function sent(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): Promise<{ url: string; payload: Record<string, unknown>; document: string | null }> {
  const fetch = mockFetch(upstream);
  const result = await railwayPlugin.execute(execCtx(fetch, resources), tool, args);
  expect(result.isError).toBeUndefined();
  expect(fetch.calls).toHaveLength(1);
  const call = fetch.calls[0]!;
  if (call.url === RAILWAY_MCP_URL) {
    const params = (call.json as { params: { arguments: Record<string, unknown> } }).params;
    return { url: call.url, payload: params.arguments, document: null };
  }
  const body = call.json as { query: string; variables: Record<string, unknown> };
  const input = body.variables.input;
  return {
    url: call.url,
    payload:
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : body.variables,
    document: body.query,
  };
}

describe('railway identifiers — a malformed id is refused by classify and by execute', () => {
  test.each(ID_CASES)('$position : $label is denied by the classifier', ({ tool, args }) => {
    expect(isDenied(tool, args)).toBe(true);
  });

  test.each(ID_CASES)(
    '$position : $label is refused by execute before any network call',
    async ({ tool, args }) => {
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test.each(NON_STRING_CASES)(
    '$position : the non-string $label is refused by both',
    async ({ tool, args }) => {
      expect(isDenied(tool, args)).toBe(true);
      await expectRefusedWithoutCall(tool, args);
    },
  );
});

describe('railway identifiers — variable names', () => {
  const UNSAFE_NAMES = HOSTILE.filter(([, v]) =>
    ['%2e%2e', '%2f', '..%2f', '', 'x'.repeat(5000), 'a\nb', 'a?x=1#y', 'a\\b'].includes(v),
  );

  test.each(UNSAFE_NAMES)('a variable named with %s is refused by both', async (_label, name) => {
    for (const [tool, args] of [
      ['railway__upsert-variable', { ...base, name, value: 'v' }],
      ['railway__delete-variable', { ...base, name }],
    ] as const) {
      expect(isDenied(tool, args)).toBe(true);
      await expectRefusedWithoutCall(tool, args);
    }
  });

  test.each(UNSAFE_NAMES.filter(([, v]) => v !== ''))(
    'a bulk upsert with a key holding %s is refused by both',
    async (_label, key) => {
      const args = { ...base, variables: { OK: '1', [key]: '2' } };
      expect(isDenied('railway__upsert-variables', args)).toBe(true);
      await expectRefusedWithoutCall('railway__upsert-variables', args);
    },
  );

  test('ordinary names are classified and sent unchanged', async () => {
    for (const name of ['API_KEY', 'NEXT_PUBLIC_URL', 'feature.flag-1']) {
      expect(slicesOf('railway__upsert-variable', { ...base, name, value: 'v' })).toEqual([
        `railway.project[${PROJECT}].environment[staging].service[*].service-var[${name}].W`,
      ]);
      const { payload } = await sent('railway__upsert-variable', { ...base, name, value: 'v' });
      expect(payload).toEqual({ projectId: PROJECT, environmentId: ENV, name, value: 'v' });
    }
  });
});

describe('railway identifiers — execute runs on the target the classifier resolved', () => {
  test.each([
    ['railway__list-services', { projectId: FOREIGN_PROJECT }],
    ['railway__list-variables', { projectId: FOREIGN_PROJECT, environmentId: ENV }],
    ['railway__redeploy', { projectId: FOREIGN_PROJECT, serviceId: SERVICE, environmentId: ENV }],
    ['railway__upsert-variable', { projectId: FOREIGN_PROJECT, name: 'K', value: 'v' }],
  ] as const)('%s on a project outside the mission is refused, no request', async (tool, args) => {
    expect(isDenied(tool, args)).toBe(true);
    await expectRefusedWithoutCall(tool, args);
  });

  const FOREIGN_ENVIRONMENT_CALLS = [
    ['railway__accept-deploy', { environmentId: FOREIGN_ENV }],
    ['railway__redeploy', { projectId: PROJECT, serviceId: SERVICE, environmentId: FOREIGN_ENV }],
    ['railway__list-variables', { environmentId: FOREIGN_ENV }],
    ['railway__upsert-variables', { environmentId: FOREIGN_ENV, variables: { A: '1' } }],
    ['railway__railway-agent', { projectId: PROJECT, environmentId: FOREIGN_ENV, message: 'x' }],
  ] as const;

  test.each(FOREIGN_ENVIRONMENT_CALLS)(
    '%s %j : an environment the single mission project does not own is refused, no request',
    async (tool, args) => {
      expect(isDenied(tool, args)).toBe(true);
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test('an environment of another project of the same mission is still not the named project’s', async () => {
    const args = { projectId: PROJECT, serviceId: SERVICE, environmentId: OTHER_ENV };
    expect(isDenied('railway__redeploy', args, [project, other])).toBe(true);
    await expectRefusedWithoutCall('railway__redeploy', args, [project, other]);
  });

  test.each(FOREIGN_ENVIRONMENT_CALLS.filter(([, args]) => !('projectId' in args)))(
    '%s %j with several projects : no project can be resolved, the call is thrown before any request',
    async (tool, args) => {
      expect(isDenied(tool, args, [project, other])).toBe(true);
      const fetch = mockFetch(upstream);
      expect(
        await refusalText(railwayPlugin.execute(execCtx(fetch, [project, other]), tool, args)),
      ).toMatch(/projectId: argument required/);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  test('accept-deploy without environmentId is refused by both', async () => {
    expect(isDenied('railway__accept-deploy', {})).toBe(true);
    await expectRefusedWithoutCall('railway__accept-deploy', {});
  });

  test('with several projects, the project owning the environment is the one sent', async () => {
    const args = { environmentId: OTHER_ENV, serviceId: SERVICE };
    expect(slicesOf('railway__redeploy', args, [project, other])).toEqual([
      `railway.project[${OTHER_PROJECT}].environment[prod].service[${SERVICE}].deployment.W`,
    ]);
    const { payload } = await sent('railway__redeploy', args, [project, other]);
    expect(payload).toEqual({
      projectId: OTHER_PROJECT,
      environmentId: OTHER_ENV,
      serviceId: SERVICE,
    });
  });

  test('the ids sent are the ids classified (rewrapped tool)', async () => {
    const args = { ...base, serviceId: SERVICE, limit: 10 };
    expect(slicesOf('railway__get-logs', args)).toEqual([
      `railway.project[${PROJECT}].environment[*].service[${SERVICE}].deployment[*].logs.R`,
    ]);
    const { url, payload } = await sent('railway__get-logs', args);
    expect(url).toBe(RAILWAY_MCP_URL);
    expect(payload).toEqual(args);
  });

  describe('an id nothing can bind to the project is refused, never forwarded', () => {
    // The credential reaches every project of the workspace: a deployment or an agent
    // thread of another project, forwarded, would be served on the mission's name.
    const UNBOUND: readonly (readonly [string, string, Record<string, unknown>, string])[] = [
      [
        'railway__get-logs',
        'deploymentId',
        { ...base, serviceId: SERVICE },
        'Give serviceId and environmentId instead',
      ],
      [
        'railway__railway-agent',
        'threadId',
        { ...base, message: 'status?' },
        'Every call starts a new conversation',
      ],
    ];
    const VALUES: readonly unknown[] = [
      DEPLOYMENT,
      '00000000-0000-4000-8000-000000000000',
      '',
      null,
      0,
      ['x'],
      { id: 'x' },
      '../other',
    ];

    test.each(UNBOUND)(
      '%s refuses %s whatever its value, in classify',
      (tool, name, ok, instead) => {
        for (const value of VALUES) {
          const out = classifyRailway(tool, { ...ok, [name]: value }, [project]);
          const refusal = 'denied' in out ? out.denied : null;
          expect(refusal, String(value)).toBe(
            `${name}: not accepted by '${tool}' — it cannot be bound to the mission's project, so it is not sent. ${UNBOUND_ARGUMENTS[tool]![name]}`,
          );
          expect(refusal).toContain(instead);
        }
        // Without it the call is classified as before.
        expect(slicesOf(tool, ok).length).toBeGreaterThan(0);
      },
    );

    test.each(UNBOUND)('%s refuses %s in execute too: nothing is sent', async (tool, name, ok) => {
      for (const value of VALUES) {
        const fetch = mockFetch([]);
        const result = await railwayPlugin.execute(execCtx(fetch), tool, {
          ...ok,
          [name]: value,
        });
        expect(result.isError, String(value)).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`${name}: not accepted by '${tool}'`);
        expect(fetch.calls).toHaveLength(0);
      }
    });

    test('the schema the agent reads does not offer them, and says so', () => {
      for (const [tool, name] of UNBOUND) {
        const declared = railwayPlugin.tools.find((t) => t.name === tool)!;
        expect(Object.keys(declared.inputSchema.properties ?? {}), tool).not.toContain(name);
        expect(declared.description, tool).toContain(`This gateway does not accept ${name}.`);
      }
      // The table names arguments the upstream tools really have: nothing is refused by a typo.
      const upstreamNames = new Map(
        (upstreamTools as { name: string; inputSchema: { properties?: object } }[]).map((t) => [
          t.name,
          Object.keys(t.inputSchema.properties ?? {}),
        ]),
      );
      for (const [tool, names] of Object.entries(UNBOUND_ARGUMENTS)) {
        for (const name of Object.keys(names)) {
          expect(upstreamNames.get(tool), `${tool}.${name}`).toContain(name);
        }
      }
    });

    test('no other declared argument of any tool is named like an id and left unbound', () => {
      // Every `…Id` an agent may send is one the classifier binds (`resolveTarget`) or the
      // account-level `workspaceId` of create-project, which names no resource of a mission.
      const BOUND = new Set(['projectId', 'environmentId', 'serviceId']);
      const ACCOUNT_LEVEL = new Set(['railway__create-project.workspaceId']);
      for (const tool of railwayPlugin.tools) {
        for (const name of Object.keys(tool.inputSchema.properties ?? {})) {
          if (!/id$/i.test(name)) continue;
          expect(
            BOUND.has(name) || ACCOUNT_LEVEL.has(`${tool.name}.${name}`),
            `${tool.name}.${name}`,
          ).toBe(true);
        }
      }
    });
  });

  test('the ids sent are the ids classified (GraphQL tool), as variables of a constant document', async () => {
    const a = await sent('railway__delete-variable', { ...base, serviceId: SERVICE, name: 'A' });
    expect(a.url).toBe(RAILWAY_GRAPHQL_URL);
    expect(a.payload).toEqual({
      projectId: PROJECT,
      environmentId: ENV,
      serviceId: SERVICE,
      name: 'A',
    });
    const b = await sent('railway__delete-variable', { environmentId: ENV, name: 'B' });
    // No argument is interpolated into the document : the text does not depend on them.
    expect(b.document).toBe(a.document);
    for (const value of [PROJECT, ENV, SERVICE, 'A']) expect(a.document).not.toContain(value);
  });

  test('a project ref that is not a Railway id is never used, named or implied', async () => {
    const odd: Resource = { ...project, ref: '../x' };
    for (const args of [{}, { projectId: odd.ref }]) {
      expect(isDenied('railway__list-services', args, [odd])).toBe(true);
      await expectRefusedWithoutCall('railway__list-services', args, [odd]);
    }
  });

  test('account-level tools are forwarded as before', async () => {
    const { payload } = await sent('railway__create-project', { name: 'new' });
    expect(payload).toEqual({ name: 'new' });
  });
});

describe('railway discovery — a project id the classifier would refuse', () => {
  test('is reported when the account is connected', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_GRAPHQL_URL,
        body: {
          data: {
            projects: {
              edges: [{ node: { id: 'a/../b', name: 'odd', environments: { edges: [] } } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const { resources: _resources, ...account } = execCtx(fetch);
    await expect(railwayPlugin.discoverResources(account)).rejects.toThrow(
      /not a Railway identifier/,
    );
  });
});

describe('railway arguments — a tool takes what its schema declares, nothing else', () => {
  const refusal = (tool: string, name: string): string =>
    `${name}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`;

  test.each<[string, Record<string, unknown>, string]>([
    // The upstream schemas of the two account tools are open: anything was forwarded.
    ['railway__whoami', { verbose: true }, 'verbose'],
    ['railway__list-projects', { teamId: 'team_1' }, 'teamId'],
    ['railway__list-services', { projectId: PROJECT, serviceId: SERVICE }, 'serviceId'],
    ['railway__redeploy', { ...base, serviceId: SERVICE, force: true }, 'force'],
    ['railway__upsert-variable', { ...base, name: 'K', value: 'v', sealed: true }, 'sealed'],
    ['railway__railway-agent', { ...base, message: 'hi', model: 'x' }, 'model'],
    // The camelCase / snake_case twin of an id names nothing.
    ['railway__redeploy', { ...base, serviceId: SERVICE, service_id: SERVICE }, 'service_id'],
  ])('%s %j is refused by classify and by execute, no request', async (tool, args, name) => {
    expect(classifyRailway(tool, args, [project])).toEqual({ denied: refusal(tool, name) });
    const fetch = mockFetch(upstream);
    const result = await railwayPlugin.execute(execCtx(fetch), tool, args);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(refusal(tool, name));
    expect(fetch.calls).toHaveLength(0);
  });

  test('`projectId` on a tool that takes none is checked, then not sent', async () => {
    // `accept-deploy` is addressed by its environment; its upstream schema is closed and
    // has no `projectId`. Naming the mission's project is a correct hint, not an error.
    const args = { projectId: PROJECT, environmentId: ENV };
    expect(isDenied('railway__accept-deploy', args)).toBe(false);
    const { payload } = await sent('railway__accept-deploy', args);
    expect(payload).toEqual({ environmentId: ENV });
    // A foreign project is still refused.
    await expectRefusedWithoutCall('railway__accept-deploy', {
      projectId: FOREIGN_PROJECT,
      environmentId: ENV,
    });
  });
});

describe('railway serviceId — bound to the project the mission holds (threat model A18)', () => {
  const FOREIGN_SERVICE = '00000000-0000-4000-8000-0000000000bb';
  const NOT_A_SERVICE = `serviceId: not a service of railway project '${PROJECT}' as last discovered ; a service created since then appears once the account owner refreshes the resources.`;

  // Every tool that takes a `serviceId`, with the other arguments it needs.
  const WITH_SERVICE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['railway__list-deployments', { projectId: PROJECT }],
    ['railway__get-logs', { ...base }],
    ['railway__redeploy', { ...base }],
    ['railway__railway-agent', { ...base, message: 'status?' }],
    ['railway__list-variables', { ...base }],
    ['railway__upsert-variable', { ...base, name: 'K', value: 'v' }],
    ['railway__upsert-variables', { ...base, variables: { A: '1' } }],
    ['railway__delete-variable', { ...base, name: 'K' }],
  ];

  test.each(WITH_SERVICE)(
    '%s : a service of another project is refused by classify and by execute, no request',
    async (tool, args) => {
      const call = { ...args, serviceId: FOREIGN_SERVICE };
      expect(classifyRailway(tool, call, [project])).toEqual({ denied: NOT_A_SERVICE });
      const fetch = mockFetch(upstream);
      const result = await railwayPlugin.execute(execCtx(fetch), tool, call);
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(NOT_A_SERVICE);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  test.each(WITH_SERVICE)("%s : the project's own service is sent as given", async (tool, args) => {
    const call = { ...args, serviceId: SERVICE };
    expect(isDenied(tool, call)).toBe(false);
    const { payload } = await sent(tool, call);
    expect(payload.serviceId).toBe(SERVICE);
  });

  test("a service of another project OF THE SAME MISSION is still not the named project's", async () => {
    const otherWithService: Resource = {
      ...other,
      metadata: { ...other.metadata, services: [{ id: FOREIGN_SERVICE, name: 'web' }] },
    };
    const call = { ...base, serviceId: FOREIGN_SERVICE };
    expect(classifyRailway('railway__redeploy', call, [project, otherWithService])).toEqual({
      denied: NOT_A_SERVICE,
    });
    await expectRefusedWithoutCall('railway__redeploy', call, [project, otherWithService]);
  });

  test('a project discovered before services were recorded names none : refused, with what to do', async () => {
    const undiscovered: Resource = {
      ...project,
      metadata: { environments: [{ id: ENV, name: 'staging' }] },
    };
    const call = { ...base, serviceId: SERVICE };
    const outcome = classifyRailway('railway__redeploy', call, [undiscovered]);
    expect(outcome).toEqual({
      denied: `serviceId: the services of railway project '${PROJECT}' are unknown ; ask the account owner to refresh the resources of the account.`,
    });
    await expectRefusedWithoutCall('railway__redeploy', call, [undiscovered]);
    // A call that names no service is not concerned.
    expect(isDenied('railway__list-variables', { ...base }, [undiscovered])).toBe(false);
  });

  test('a project with no service at all refuses every serviceId', () => {
    const empty: Resource = { ...project, metadata: { ...project.metadata, services: [] } };
    expect(classifyRailway('railway__redeploy', { ...base, serviceId: SERVICE }, [empty])).toEqual({
      denied: NOT_A_SERVICE,
    });
  });

  test('a malformed list in the metadata binds nothing', () => {
    for (const services of ['nope', [{ id: 1, name: 'x' }], [SERVICE], [{ id: SERVICE }]]) {
      const odd: Resource = { ...project, metadata: { ...project.metadata, services } };
      expect(
        isDenied('railway__redeploy', { ...base, serviceId: SERVICE }, [odd]),
        JSON.stringify(services),
      ).toBe(true);
    }
  });
});
