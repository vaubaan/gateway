/**
 * Test fixtures for the connect flows. Not for production.
 *
 * `fixturePlugin()` builds the smallest plugin `definePlugin` accepts around
 * a given `CredentialSpec`, so every credential kind can be driven without a
 * real provider plugin; the `*_SPEC` constants are one spec per kind, with
 * endpoints on RFC 2606 hosts. `connectionsHarness()` assembles the
 * module over the `:memory:` store, in-memory ports and a `mockFetch`.
 */
import {
  createRegistry,
  definePlugin,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialSecret,
  type CredentialSpec,
  type OAuth2CredentialSpec,
  type PluginRegistry,
  type ProviderPlugin,
  type Resource,
  type SshKeyCredentialSpec,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { parseSlice } from '@vaubaan/policy-engine';
import { MemoryAuditWriter } from '@vaubaan/gateway-core';

import { createAuthorityModule } from '../authority';
import { MemoryRateLimiter, MemorySessionStore } from '../compose/memory';
import type { ProviderAppConfig as FileProviderAppConfig } from '../config/types';
import { silentLogger } from '../logging';
import { ProviderAppsService } from '../provider-apps';
import { openTestStore, type TestStore } from '../store/testing';
import type { GroupRecord, UserRecord } from '../store/types';
import { CredentialBroker } from './credentials';
import { NoticeStore, PendingConnectStore } from './pending';
import { ConnectionService, type Actor } from './service';

export const PUBLIC_URL = new URL('https://gateway.example.com');

export const OAUTH_SPEC: OAuth2CredentialSpec = {
  kind: 'oauth2',
  authorizationUrl: 'https://provider.example.com/oauth/authorize',
  tokenUrl: 'https://provider.example.com/oauth/token',
  scopes: ['read', 'write'],
  pkce: true,
  clientAuthMethod: 'client_secret_basic',
  refreshable: true,
};

export const API_KEY_SPEC: ApiKeyCredentialSpec = {
  kind: 'api-key',
  createUrl: 'https://keys.example.com/tokens',
  fields: [
    { name: 'token', label: 'Access token', secret: true },
    { name: 'team_id', label: 'Team ID', secret: false, pattern: '^team_[a-z0-9]+$' },
    { name: 'note', label: 'Note', secret: false, required: false },
  ],
};

export const SSH_KEY_SPEC: SshKeyCredentialSpec = {
  kind: 'ssh-key',
  algorithm: 'ed25519',
  fields: [
    { name: 'host', label: 'Host', secret: false, pattern: '^[a-z0-9.-]+$' },
    { name: 'user', label: 'Login user', secret: false },
  ],
};

export interface FixturePluginOptions {
  readonly id: string;
  readonly credential: CredentialSpec;
  /** Tool titles, keyed by tool name. */
  readonly toolTitles?: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly experimental?: boolean;
  readonly discoverResources?: (ctx: ConnectionContext) => Promise<readonly Resource[]>;
  readonly refresh?: (ctx: ConnectionContext) => Promise<CredentialSecret>;
  readonly revoke?: (ctx: ConnectionContext) => Promise<void>;
  readonly manualRevocation?: string;
  /**
   * Adds an env-scoped risk (`<id>.write-things`, acceptable in these environments):
   * a catalog that knows environment labels.
   */
  readonly envs?: readonly string[];
}

/** A valid plugin whose id is a slug without dashes (so the tool prefix is `<id>__`). */
export function fixturePlugin(options: FixturePluginOptions): ProviderPlugin {
  const { id } = options;
  const vector = {
    reversibility: 'reversible',
    blast: 'single',
    data: 'data',
    cost: 'free',
    visibility: 'internal',
    persistence: 'stateless',
  } as const;
  return definePlugin({
    id,
    displayName: options.displayName ?? id,
    version: '0.0.1',
    description: `Fixture provider ${id}.`,
    ...(options.experimental ? { experimental: true } : {}),
    tools: [
      {
        name: `${id}__list_things`,
        description: 'List the things of a space.',
        inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
      },
    ],
    dataModel: {
      provider: id,
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
              name: 'thing',
              parent: 'space',
              cardinalities: ['one', 'unbounded'],
              description: 'A thing.',
            },
          ],
        },
      ],
    },
    catalog: {
      provider: id,
      risks: [
        {
          id: `${id}.read-things`,
          label: 'Read things',
          reason: 'Reads leak nothing but the thing itself.',
          matches: `${id}.space[**].thing[**].R`,
          vector,
        },
        ...(options.envs && options.envs.length > 0
          ? [
              {
                id: `${id}.write-things`,
                label: 'Write things',
                reason: 'A write changes the thing in one environment.',
                matches: `${id}.space[**].thing[**].W`,
                acceptable_in_envs: [...options.envs],
                vector,
              },
            ]
          : []),
        {
          id: `${id}.uncategorized-write`,
          label: 'Uncategorized write',
          reason: 'Catch-all for writes the catalog does not name.',
          matches: `${id}.**.W`,
          fallback: true,
          vector: { ...vector, reversibility: 'costly', blast: 'env' },
        },
      ],
      presets: [
        {
          id: 'reader',
          label: 'Reader',
          description: 'Read-only access.',
          entries: [
            {
              risk_id: `${id}.read-things`,
              quota: 100,
              rate_limit: { max: 60, window_seconds: 60 },
              gate: 'auto',
            },
          ],
        },
      ],
    },
    credential: options.credential,
    ...(options.toolTitles ? { toolTitles: options.toolTitles } : {}),
    classify(_tool, args) {
      const space = typeof args.space === 'string' ? args.space : null;
      if (!space) return { denied: 'space: argument missing' };
      return { slices: [parseSlice(`${id}.space[${space}].thing[*].R`)] };
    },
    async execute() {
      return { content: [{ type: 'text', text: '[]' }] };
    },
    discoverResources: options.discoverResources ?? (async () => []),
    ...(options.refresh ? { refresh: options.refresh } : {}),
    ...(options.revoke ? { revoke: options.revoke } : {}),
    ...(options.manualRevocation ? { manualRevocation: options.manualRevocation } : {}),
  });
}

export interface HarnessOptions {
  readonly plugins: readonly ProviderPlugin[];
  readonly routes?: readonly MockRoute[];
  /** `providers.<id>` blocks of the mounted configuration. */
  readonly fileApps?: ReadonlyMap<string, FileProviderAppConfig>;
}

export interface ConnectionsHarness extends TestStore {
  readonly registry: PluginRegistry;
  readonly fetch: MockFetch;
  readonly providerApps: ProviderAppsService;
  readonly broker: CredentialBroker;
  readonly service: ConnectionService;
  readonly pending: PendingConnectStore;
  readonly notices: NoticeStore;
  readonly sessions: MemorySessionStore;
  readonly audit: MemoryAuditWriter;
  /** Creates a user (and optional groups they belong to) and returns the actor. */
  actor(email: string, groupNames?: readonly string[]): Promise<Actor>;
}

export function connectionsHarness(options: HarnessOptions): ConnectionsHarness {
  const test = openTestStore();
  const registry = createRegistry(options.plugins);
  const fetch = mockFetch(options.routes ?? []);
  const now = (): number => test.clock.now().getTime();
  const sessions = new MemorySessionStore(now);
  const providerApps = new ProviderAppsService(
    options.fileApps ?? new Map(),
    test.store.config,
    registry,
  );
  const audit = new MemoryAuditWriter();
  const broker = new CredentialBroker({
    connections: test.store.connections,
    registry,
    providerApps,
    fetch,
    clock: test.clock,
    logger: silentLogger,
  });
  const pending = new PendingConnectStore(sessions);
  const authority = createAuthorityModule({
    store: test.store,
    registry,
    logger: silentLogger,
    clock: test.clock,
  });
  const service = new ConnectionService({
    store: test.store,
    registry,
    providerApps,
    broker,
    grounds: authority.grounds,
    pending,
    rateLimiter: new MemoryRateLimiter(now),
    audit,
    publicUrl: PUBLIC_URL,
    fetch,
    clock: test.clock,
    logger: silentLogger,
  });
  return {
    ...test,
    registry,
    fetch,
    providerApps,
    broker,
    service,
    pending,
    notices: new NoticeStore(sessions),
    sessions,
    audit,
    async actor(email, groupNames = []) {
      const user: UserRecord = await test.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: email,
        email,
      });
      const groups: GroupRecord[] = [];
      for (const name of groupNames) {
        const group = await test.store.groups.getOrCreate(name, 'idp');
        await test.store.groups.addMember(group.id, user.id);
        groups.push(group);
      }
      return { user, groups };
    },
  };
}

/** The `state` of the authorization (or installation) URL a flow redirected to. */
export function stateOf(redirectUrl: string): string {
  const state = new URL(redirectUrl).searchParams.get('state');
  if (!state) throw new Error('no state in the redirect URL');
  return state;
}
