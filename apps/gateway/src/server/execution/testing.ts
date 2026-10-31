/**
 * Test fixtures for the execution door. Not for production.
 *
 * `depotPlugin()` is a small provider with every shape the pipeline must
 * handle — a resource ref the classifier requires, an account-level tool, an
 * env-scoped risk, a risk meant to be gated — and an `execute` the test
 * scripts. `executionInstance()` builds the real composition root on the
 * `:memory:` store with that plugin (and any other), then seeds a user, a
 * connection with its resources and a mission through the repositories and the
 * mission service, the way an operator would.
 */
import {
  createRegistry,
  definePlugin,
  jsonObjectsOf,
  UpstreamAuthError,
  type CredentialSecret,
  type ExecuteContext,
  type McpToolResult,
  type ProviderPlugin,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { apiKeyCredentialFixture } from '@vaubaan/plugin-sdk/testing';
import { parseSlice } from '@vaubaan/policy-engine';
import type { MissionPolicyEntry } from '@vaubaan/shared';

import { buildRoot, type GatewayRoot, type RootDeps } from '../compose/root';
import { memoryStoreDeps } from '../compose/testing';
import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { serializeSecret } from '../connections';
import type { MissionDraft } from '../missions';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  MissionRecord,
  UserRecord,
} from '../store/types';

export const DEPOT = 'depot';
export const DEPOT_API_KEY = 'sk-depot-never-returned';

const VECTOR = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
  persistence: 'stateless',
} as const;

export type DepotExecute = (
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<McpToolResult>;

export interface DepotPlugin {
  readonly plugin: ProviderPlugin;
  /** Every `execute` call, in order. */
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>>; ctx: ExecuteContext }[];
  /** Replace what `execute` does; `null` restores the echo. */
  script(execute: DepotExecute | null): void;
  /** Replace what `discoverResources` returns (default: nothing); `null` restores it. */
  scriptDiscovery(discover: (() => Promise<readonly Resource[]>) | null): void;
  /** How many times `discoverResources` ran. */
  readonly discoveries: () => number;
  /** Replace what the plugin's `refresh` hook does (default: rejects — an api key cannot refresh). */
  scriptRefresh(refresh: (() => Promise<CredentialSecret>) | null): void;
  /**
   * Makes the classifier throw what `fault` returns for a call (a classifier is total
   * by contract; this is the bug the pipeline must survive). `null` restores it.
   */
  breakClassifier(
    fault: ((tool: string, args: Readonly<Record<string, unknown>>) => Error) | null,
  ): void;
}

/**
 * Tools: `depot__read_item {space?, item?}`, `depot__write_item {space?}`,
 * `depot__purge {space?}`, `depot__whoami {}`, `depot__create_space {space}`.
 * A space is a resource ref; it defaults to the mission's single resource and
 * must be one of them — except for `create_space`, an account-level write that
 * creates one (declared in `resourceCreatingTools`).
 */
export function depotPlugin(): DepotPlugin {
  const calls: DepotPlugin['calls'] = [];
  let scripted: DepotExecute | null = null;
  let scriptedRefresh: (() => Promise<CredentialSecret>) | null = null;
  let scriptedDiscovery: (() => Promise<readonly Resource[]>) | null = null;
  let discoveries = 0;
  let classifierFault: Parameters<DepotPlugin['breakClassifier']>[0] = null;

  const tool = (name: string, description: string) => ({
    name: `${DEPOT}__${name}`,
    description,
    inputSchema: {
      type: 'object' as const,
      properties: { space: { type: 'string' }, item: { type: 'string' } },
    },
  });

  const plugin = definePlugin({
    id: DEPOT,
    displayName: 'Depot',
    version: '0.0.1',
    description: 'Fixture provider of the execution door tests.',
    tools: [
      tool('read_item', 'Read an item of a space.'),
      tool('write_item', 'Write an item of a space.'),
      tool('purge', 'Delete every item of a space.'),
      tool('whoami', 'The account behind the connection.'),
      tool('create_space', 'Create a space.'),
    ],
    resourceCreatingTools: [`${DEPOT}__create_space`],
    dataModel: {
      provider: DEPOT,
      planes: [
        {
          slug: 'space',
          entities: [
            {
              name: 'space',
              parent: null,
              cardinalities: ['one'],
              description: 'A space.',
              envScopable: true,
            },
            {
              name: 'item',
              parent: 'space',
              cardinalities: ['one', 'unbounded'],
              description: 'An item.',
            },
            {
              name: 'account',
              parent: null,
              cardinalities: ['one'],
              description: 'The account behind the connection: its profile, its spaces.',
            },
          ],
        },
      ],
    },
    catalog: {
      provider: DEPOT,
      risks: [
        {
          id: `${DEPOT}.read`,
          label: 'Read items',
          reason: 'Reads leak nothing but the item itself.',
          matches: `${DEPOT}.space[**].item[**].R`,
          vector: VECTOR,
        },
        {
          id: `${DEPOT}.write`,
          label: 'Write an item',
          reason: 'Reversible edit of one item.',
          matches: `${DEPOT}.space[**].item[**].W`,
          acceptable_in_envs: ['staging', 'prod'],
          vector: { ...VECTOR, persistence: 'session' },
        },
        {
          id: `${DEPOT}.purge`,
          label: 'Purge a space',
          reason: 'No undo.',
          matches: `${DEPOT}.space[**].purge.W`,
          vector: { ...VECTOR, reversibility: 'irreversible', blast: 'bulk' },
        },
        {
          id: `${DEPOT}.profile`,
          label: 'Read the account profile',
          reason: 'Account-level read.',
          matches: `${DEPOT}.account.profile.R`,
          vector: VECTOR,
        },
        {
          id: `${DEPOT}.uncategorized-write`,
          label: 'Uncategorized write',
          reason: 'Catch-all for writes the catalog does not name.',
          matches: `${DEPOT}.**.W`,
          fallback: true,
          vector: { ...VECTOR, reversibility: 'costly', blast: 'env' },
        },
      ],
      macro_actions: [
        {
          id: 'read',
          label: 'Read',
          description: 'Read items and the profile.',
          entries: [
            { risk_id: `${DEPOT}.read`, quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
            {
              risk_id: `${DEPOT}.profile`,
              quota: 100,
              rate_limit: { max: 60, window_seconds: 60 },
            },
          ],
        },
        {
          id: 'change',
          label: 'Change',
          description: 'Write items and purge spaces.',
          entries: [
            { risk_id: `${DEPOT}.write`, quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
            { risk_id: `${DEPOT}.purge`, quota: 5, rate_limit: { max: 1, window_seconds: 60 } },
          ],
        },
      ],
    },
    credential: apiKeyCredentialFixture([{ name: 'token', label: 'Token', secret: true }]),
    classify(name, args, resources) {
      if (classifierFault) throw classifierFault(name, args);
      if (name === `${DEPOT}__whoami`)
        return { slices: [parseSlice(`${DEPOT}.account.profile.R`)] };
      // No risk of its own: the catalog's fallback write covers it (the shares
      // tests pin the catalog's explicit ids).
      if (name === `${DEPOT}__create_space`)
        return { slices: [parseSlice(`${DEPOT}.account.spaces.W`)] };
      const refs = resources.filter((r) => r.provider === DEPOT).map((r) => r.ref);
      const space =
        typeof args.space === 'string' ? args.space : refs.length === 1 ? refs[0] : undefined;
      if (space === undefined) return { denied: `${name} requires 'space'.` };
      if (!/^[a-z0-9-]+$/.test(space)) return { denied: `space '${space}' is not a valid ref.` };
      if (!refs.includes(space)) return { denied: `space '${space}' is not part of this mission.` };
      switch (name) {
        case `${DEPOT}__read_item`:
          return { slices: [parseSlice(`${DEPOT}.space[${space}].item[*].R`)] };
        case `${DEPOT}__write_item`:
          return { slices: [parseSlice(`${DEPOT}.space[${space}].item[*].W`)] };
        case `${DEPOT}__purge`:
          return { slices: [parseSlice(`${DEPOT}.space[${space}].purge.W`)] };
        default:
          return { denied: `unknown tool ${name}` };
      }
    },
    async execute(ctx, name, args) {
      calls.push({ tool: name, args, ctx });
      if (scripted) return scripted(ctx, name, args);
      return { content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }] };
    },
    async discoverResources() {
      discoveries += 1;
      return scriptedDiscovery ? scriptedDiscovery() : [];
    },
    // A scripted `create_space` answers `{ "created": { "ref", "name"? } }`; the default
    // answer (the call echoed) names nothing it created.
    createdResources(name, _args, result) {
      if (name !== `${DEPOT}__create_space`) return [];
      return jsonObjectsOf(result).flatMap((answer) => {
        const created = answer.created as { ref?: unknown; name?: unknown } | undefined;
        const ref = created?.ref;
        if (typeof ref !== 'string' || !/^[a-z0-9-]+$/.test(ref)) return [];
        return [
          {
            provider: DEPOT,
            ref,
            displayName: typeof created?.name === 'string' ? created.name : ref,
            metadata: { created_by_call: true },
          },
        ];
      });
    },
    async refresh() {
      if (scriptedRefresh) return scriptedRefresh();
      throw new UpstreamAuthError('the key was revoked at the provider', 401);
    },
  });

  return {
    plugin,
    calls,
    script: (execute) => {
      scripted = execute;
    },
    scriptDiscovery: (discover) => {
      scriptedDiscovery = discover;
    },
    discoveries: () => discoveries,
    scriptRefresh: (refresh) => {
      scriptedRefresh = refresh;
    },
    breakClassifier: (fault) => {
      classifierFault = fault;
    },
  };
}

export const depotSecret = (token: string = DEPOT_API_KEY): CredentialSecret => ({
  kind: 'api-key',
  fields: { token },
  metadata: {},
});

export interface SeedSpace {
  readonly ref: string;
  readonly env?: string | null;
}

export const DEFAULT_SPACES: readonly SeedSpace[] = [
  { ref: 'app-staging', env: 'staging' },
  { ref: 'app-prod', env: 'prod' },
  { ref: 'scratch' },
];

export const line = (
  riskId: string,
  quota = 100,
  overrides: Partial<Pick<MissionPolicyEntry, 'rate_limit' | 'gate'>> = {},
): MissionPolicyEntry => ({
  risk_id: riskId,
  quota,
  rate_limit: { max: 1000, window_seconds: 60 },
  gate: 'auto',
  ...overrides,
});

export interface IssuedMission {
  readonly mission: MissionRecord;
  /** The bearer. */
  readonly token: string;
  readonly prefix: string;
}

export interface ExecutionInstance {
  readonly root: GatewayRoot;
  readonly depot: DepotPlugin;
  readonly ada: UserRecord;
  readonly connection: ConnectionRecord;
  readonly resources: readonly ConnectionResourceRecord[];
  /** Issues a mission on the Depot connection for Ada. */
  issue(input: {
    readonly policy: readonly MissionPolicyEntry[];
    /** Resource refs; default: every seeded space. */
    readonly spaces?: readonly string[];
    /** Issue on the whole connection (scope `connection`); `spaces` is then ignored. */
    readonly wholeConnection?: boolean;
    readonly period?: MissionDraft['period'];
    readonly name?: string;
  }): Promise<IssuedMission>;
  /** A JSON-RPC POST to the door; `token` null sends no Authorization header. */
  rpc(
    token: string | null,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Headers; body: RpcBody }>;
  call(
    mission: IssuedMission,
    tool: string,
    args?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<RpcBody>;
  close(): Promise<void>;
}

export interface RpcBody {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data?: Record<string, unknown> };
}

export const TEST_PUBLIC_URL = 'https://gateway.example.com';

export interface ExecutionInstanceOptions {
  readonly plugins?: readonly ProviderPlugin[];
  readonly spaces?: readonly SeedSpace[];
  readonly env?: Record<string, string | undefined>;
  readonly deps?: RootDeps;
}

export async function executionInstance(
  options: ExecutionInstanceOptions = {},
): Promise<ExecutionInstance> {
  const depot = depotPlugin();
  const root = await buildRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({ VAUBAAN_PUBLIC_URL: TEST_PUBLIC_URL, ...options.env }),
      }),
    logWrite: () => undefined,
    buildRegistry: async () => createRegistry([depot.plugin, ...(options.plugins ?? [])]),
    ...memoryStoreDeps,
    ...options.deps,
  });
  const ada = await root.store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'idp|ada',
    email: 'ada@example.com',
    displayName: 'Ada',
  });
  const connection = await root.store.connections.create({
    provider: DEPOT,
    owner: { kind: 'user', id: ada.id },
    displayName: 'Depot main',
    credential: serializeSecret(depotSecret()),
  });
  const resources = await root.store.connections.syncDiscoveredResources(
    connection.id,
    (options.spaces ?? DEFAULT_SPACES).map((s) => ({
      ref: s.ref,
      displayName: s.ref,
      env: s.env ?? null,
    })),
  );

  let nextId = 1;
  const instance: ExecutionInstance = {
    root,
    depot,
    ada,
    connection,
    resources,
    async issue(input) {
      const result = await root.missions.service.issue(ada, {
        name: input.name ?? 'Test mission',
        connections: [
          {
            connection_id: connection.id,
            resources: input.wholeConnection
              ? { scope: 'connection' }
              : input.spaces
                ? { scope: 'selected', resource_refs: [...input.spaces] }
                : { scope: 'all' },
            policy: [...input.policy],
          },
        ],
        period: input.period ?? { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
      return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
    },
    async rpc(token, body, headers = {}) {
      const response = await root.execution.handlers.mcp(
        new Request(`${TEST_PUBLIC_URL}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: (text ? JSON.parse(text) : {}) as RpcBody,
      };
    },
    async call(mission, tool, args = {}, headers = {}) {
      const { body } = await instance.rpc(
        mission.token,
        {
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        },
        headers,
      );
      return body;
    },
    close: () => root.close(),
  };
  return instance;
}
