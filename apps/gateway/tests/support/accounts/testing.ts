/**
 * Test fixtures for the connect flows. Not for production.
 *
 * `fixturePlugin()` builds the smallest plugin `definePlugin` accepts around
 * a given `CredentialSpec`, so every credential kind can be driven without a
 * real plugin; the `*_SPEC` constants are one spec per kind, with
 * endpoints on RFC 2606 hosts. `accountsHarness()` assembles the
 * module over the `:memory:` store, in-memory ports and a `mockFetch`.
 */
import {
  createRegistry,
  definePlugin,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialSecret,
  type CredentialSpec,
  type OAuth2RegisteredClientSpec,
  type PluginRegistry,
  type ServicePlugin,
  type Resource,
  type SshKeyCredentialSpec,
} from '@vaubaan/plugin-sdk';
import {
  apiKeyCredentialFixture,
  mockFetch,
  type MockFetch,
  type MockRoute,
} from '@vaubaan/plugin-sdk/testing';
import { parseSlice } from '@vaubaan/policy-engine';
import { MemoryAuditWriter } from '@vaubaan/gateway-core';

import { createAuthorityModule } from '../../../src/server/authority';
import { MemoryRateLimiter, MemorySessionStore } from '../../../src/server/compose/memory';
import { silentLogger } from '../../../src/server/logging';
import type { ConfigRepo } from '../../../src/server/store/repositories/config';
import { openTestStore, type TestStore } from '../store/testing';
import type { GroupRecord, UserRecord } from '../../../src/server/store/types';
import { CredentialBroker } from '../../../src/server/accounts/credentials';
import type { OAuthBrokerConfig } from '../../../src/server/config/types';
import { OAuth2Clients, registeredClientKey } from '../../../src/server/accounts/oauth2-clients';
import type { BrokerAttestationKit } from '../../../src/server/accounts/broker-attestation';
import { OAuthBrokers } from '../../../src/server/accounts/oauth-broker';
import { NoticeStore, PendingConnectStore } from '../../../src/server/accounts/pending';
import { AccountService, type Actor } from '../../../src/server/accounts/service';

export const PUBLIC_URL = new URL('https://gateway.example.com');

/**
 * An `oauth2` way. Its client is one the gateway registers itself, the only kind
 * there is (ADR gmail-over-imap-with-an-app-password); a test that is not about
 * the registration seeds it with `AccountsHarness.seedClient`.
 */
export const OAUTH_SPEC: OAuth2RegisteredClientSpec = {
  kind: 'oauth2',
  authorizationUrl: 'https://service.example.com/oauth/authorize',
  tokenUrl: 'https://service.example.com/oauth/token',
  clientRegistration: { registrationUrl: 'https://service.example.com/oauth/register' },
  scopes: ['read', 'write'],
  pkce: true,
  clientAuthMethod: 'client_secret_basic',
  refreshable: true,
};

/** An `oauth2` way whose client the gateway registers itself (RFC 7591), like Miro's MCP server. */
export const REGISTERED_OAUTH_SPEC: OAuth2RegisteredClientSpec = {
  kind: 'oauth2',
  authorizationUrl: 'https://mcp.service.example.com/authorize',
  tokenUrl: 'https://mcp.service.example.com/token',
  clientRegistration: { registrationUrl: 'https://mcp.service.example.com/register' },
  scopes: ['boards:read', 'boards:write'],
  pkce: true,
  resourceIndicator: 'https://mcp.service.example.com/',
  clientAuthMethod: 'client_secret_post',
  refreshable: true,
};

export const API_KEY_SPEC: ApiKeyCredentialSpec = apiKeyCredentialFixture(
  [
    { name: 'token', label: 'Access token', secret: true },
    { name: 'team_id', label: 'Team ID', secret: false, pattern: '^team_[a-z0-9]+$' },
    { name: 'note', label: 'Note', secret: false, required: false },
  ],
  { createUrl: 'https://keys.example.com/tokens' },
);

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
  readonly discoverResources?: (ctx: AccountContext) => Promise<readonly Resource[]>;
  readonly refresh?: (ctx: AccountContext) => Promise<CredentialSecret>;
  readonly revoke?: (ctx: AccountContext) => Promise<void>;
  readonly manualRevocation?: string;
  /**
   * Adds an env-scoped risk (`<id>.write-things`, acceptable in these environments):
   * a catalog that knows environment labels.
   */
  readonly envs?: readonly string[];
}

/** A valid plugin whose id is a slug without dashes (so the tool prefix is `<id>__`). */
export function fixturePlugin(options: FixturePluginOptions): ServicePlugin {
  const { id } = options;
  const vector = {
    reversibility: 'reversible',
    blast: 'single',
    data: 'data',
    cost: 'free',
    visibility: 'internal',
  } as const;
  return definePlugin({
    id,
    displayName: options.displayName ?? id,
    version: '0.0.1',
    description: `Fixture service ${id}.`,
    tools: [
      {
        name: `${id}__list_things`,
        description: 'List the things of a space.',
        inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
      },
    ],
    dataModel: {
      service: id,
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
      service: id,
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
      macro_actions: [
        {
          id: 'read',
          label: 'Read',
          description: 'Read things.',
          entries: [
            {
              risk_id: `${id}.read-things`,
              quota: 100,
              rate_limit: { max: 60, window_seconds: 60 },
            },
          ],
        },
        ...(options.envs && options.envs.length > 0
          ? [
              {
                id: 'write',
                label: 'Write',
                description: 'Write things.',
                entries: [
                  {
                    risk_id: `${id}.write-things`,
                    quota: 100,
                    rate_limit: { max: 60, window_seconds: 60 },
                  },
                ],
              },
            ]
          : []),
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
  readonly plugins: readonly ServicePlugin[];
  readonly routes?: readonly MockRoute[];
  /**
   * The OAuth brokers the instance is enrolled with. Calls to their URLs go to
   * the network (a `FakeOAuthBroker` on the loopback interface); every other
   * call goes to the `mockFetch` of `routes`.
   */
  readonly brokers?: readonly OAuthBrokerConfig[];
  /**
   * The attestation adapters and allowlist the brokers are verified with
   * (`FakeOAuthBroker.attestationKit()`); by default none, which admits no
   * attested broker.
   */
  readonly brokerAttestation?: BrokerAttestationKit;
  /**
   * How a broker declared `attestation: none` is reached (default: the
   * platform's `fetch`); `FakeOAuthBroker.trustingFetch()` checks its
   * certificate against its own authority.
   */
  readonly brokerFetch?: typeof fetch;
}

export interface AccountsHarness extends TestStore {
  readonly registry: PluginRegistry;
  readonly fetch: MockFetch;
  readonly clients: OAuth2Clients;
  readonly brokers: OAuthBrokers;
  readonly broker: CredentialBroker;
  readonly service: AccountService;
  readonly pending: PendingConnectStore;
  readonly notices: NoticeStore;
  readonly sessions: MemorySessionStore;
  readonly audit: MemoryAuditWriter;
  /** Creates a user (and optional groups they belong to) and returns the actor. */
  actor(email: string, groupNames?: readonly string[]): Promise<Actor>;
  /**
   * Keeps a client as if the gateway had registered it at the service for this
   * instance's callback: what a test of the flows, not of the registration, starts from.
   */
  seedClient(serviceId: string, clientId: string, clientSecret: string | null): Promise<void>;
}

export function accountsHarness(options: HarnessOptions): AccountsHarness {
  const test = openTestStore();
  const registry = createRegistry(options.plugins);
  const fetch = mockFetch(options.routes ?? []);
  const brokerConfigs = options.brokers ?? [];
  const outbound: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return brokerConfigs.some((b) => url.startsWith(b.url.href))
      ? (options.brokerFetch ?? globalThis.fetch)(input, init)
      : fetch(input, init);
  };
  const now = (): number => test.clock.now().getTime();
  const brokers = new OAuthBrokers(brokerConfigs, {
    fetch: outbound,
    attestation: options.brokerAttestation ?? { platforms: [], allowlist: [] },
    now,
  });
  const sessions = new MemorySessionStore(now);
  const audit = new MemoryAuditWriter();
  const clients = new OAuth2Clients({
    config: test.store.config,
    publicUrl: PUBLIC_URL,
    fetch,
    clock: test.clock,
    logger: silentLogger,
  });
  const broker = new CredentialBroker({
    accounts: test.store.accounts,
    registry,
    clients,
    brokers,
    fetch: outbound,
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
  const service = new AccountService({
    store: test.store,
    registry,
    clients,
    brokers,
    broker,
    grounds: authority.grounds,
    pending,
    rateLimiter: new MemoryRateLimiter(now),
    audit,
    publicUrl: PUBLIC_URL,
    fetch: outbound,
    clock: test.clock,
    logger: silentLogger,
  });
  return {
    ...test,
    registry,
    fetch,
    clients,
    brokers,
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
        const group = await test.store.groups.getOrCreate(name, 'idp', 'idp');
        await test.store.groups.addMember(group.id, user.id);
        groups.push(group);
      }
      return { user, groups };
    },
    async seedClient(serviceId, clientId, clientSecret) {
      await seedRegisteredClient(test.store.config, {
        serviceId,
        clientId,
        clientSecret,
        redirectUri: service.callbackUrl(serviceId).href,
        at: test.clock.now(),
      });
    },
  };
}

/**
 * Keeps a client in `instance_config` as `OAuth2Clients` keeps one it registered
 * at the service for `redirectUri`: the starting point of a test of the flows,
 * not of the registration (oauth2-clients.test.ts).
 */
export async function seedRegisteredClient(
  config: Pick<ConfigRepo, 'apply'>,
  client: {
    readonly serviceId: string;
    readonly clientId: string;
    readonly clientSecret: string | null;
    readonly redirectUri: string;
    readonly at: Date;
  },
): Promise<void> {
  const { serviceId } = client;
  await config.apply([
    { kind: 'value', key: registeredClientKey(serviceId, 'client_id'), value: client.clientId },
    client.clientSecret === null
      ? { kind: 'delete', key: registeredClientKey(serviceId, 'client_secret') }
      : {
          kind: 'secret',
          key: registeredClientKey(serviceId, 'client_secret'),
          plain: client.clientSecret,
        },
    {
      kind: 'value',
      key: registeredClientKey(serviceId, 'redirect_uri'),
      value: client.redirectUri,
    },
    {
      kind: 'value',
      key: registeredClientKey(serviceId, 'registered_at'),
      value: client.at.toISOString(),
    },
  ]);
}

/** The `state` of the authorization (or installation) URL a flow redirected to. */
export function stateOf(redirectUrl: string): string {
  const state = new URL(redirectUrl).searchParams.get('state');
  if (!state) throw new Error('no state in the redirect URL');
  return state;
}
