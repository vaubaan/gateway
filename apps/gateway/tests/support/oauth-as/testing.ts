/**
 * Test rig of the authorization server. Not for production.
 *
 * The services of the module over the store's `:memory:` mode, a manual clock,
 * in-memory ports and gateway-core's `MemoryAuditWriter` — everything but the
 * HTTP handlers, which need the human-authentication module and are tested on
 * the real composition root (`tests/integration/oauth-as`).
 */
import { randomBytes } from 'node:crypto';

import { MemoryAuditWriter } from '@vaubaan/gateway-core';

import { MemoryRateLimiter, MemorySessionStore } from '../../../src/server/compose/memory';
import type { OAuthConfig } from '../../../src/server/config/types';
import { silentLogger } from '../../../src/server/logging';
import type { Store } from '../../../src/server/store';
import type { ManualClock } from '../../../src/server/store/clock';
import { openTestStore } from '../store/testing';
import type { OAuthClientRecord, UserRecord } from '../../../src/server/store/types';
import { AuthorizationService } from '../../../src/server/oauth-as/authorization';
import type { ClientDocumentFetcher } from '../../../src/server/oauth-as/client-metadata-document';
import { ClientRegistry } from '../../../src/server/oauth-as/clients';
import { delegationLifetime } from '../../../src/server/oauth-as/delegation-lifetime';
import { DelegationService } from '../../../src/server/oauth-as/delegations';
import { oauthEndpoints, type OAuthEndpoints } from '../../../src/server/oauth-as/endpoints';
import { challengeOf } from '../../../src/server/oauth-as/pkce';
import { TokenService, type TokenResponse } from '../../../src/server/oauth-as/token-service';
import { DelegatedTokenVerifier } from '../../../src/server/oauth-as/verifier';

export const TEST_PUBLIC_URL = 'https://gateway.example.com';
export const LOOPBACK_REDIRECT = 'http://127.0.0.1:43210/callback';
export const WEB_REDIRECT = 'https://agent.example.net/oauth/callback';

export const DEFAULT_TEST_OAUTH: OAuthConfig = {
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 30 * 86_400,
  delegationMaxLifetimeSeconds: 90 * 86_400,
  refreshReuseWindowSeconds: 30,
  clientRegistration: {
    policy: 'operator-approved',
    autoApproveLoopback: true,
    metadataDocuments: false,
  },
};

export interface OAuthRigOptions {
  readonly registration?: Partial<OAuthConfig['clientRegistration']>;
  readonly ttl?: Partial<
    Pick<
      OAuthConfig,
      | 'accessTokenTtlSeconds'
      | 'refreshTokenTtlSeconds'
      | 'refreshReuseWindowSeconds'
      | 'delegationMaxLifetimeSeconds'
    >
  >;
  readonly fetchDocument?: ClientDocumentFetcher;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** A fresh PKCE verifier with its S256 challenge. */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: challengeOf(verifier) };
}

export interface Granted {
  readonly code: string;
  readonly pkce: PkcePair;
  readonly redirectUri: string;
  readonly delegationId: string;
}

export interface OAuthRig {
  readonly store: Store;
  readonly clock: ManualClock;
  readonly audit: MemoryAuditWriter;
  readonly config: OAuthConfig;
  readonly endpoints: OAuthEndpoints;
  readonly clients: ClientRegistry;
  readonly authorization: AuthorizationService;
  readonly tokens: TokenService;
  readonly delegations: DelegationService;
  readonly verifier: DelegatedTokenVerifier;
  readonly ada: UserRecord;
  readonly bob: UserRecord;
  /** A public client redirecting to the loopback interface (approved by the default policy). */
  registerClient(redirectUris?: readonly string[], name?: string): Promise<OAuthClientRecord>;
  /** The consent screen shown and approved: a delegation and its authorization code. */
  grant(user: UserRecord, client: OAuthClientRecord, redirectUri?: string): Promise<Granted>;
  /** `grant` then the code exchange: the first pair of tokens of a delegation. */
  issue(
    user: UserRecord,
    client: OAuthClientRecord,
  ): Promise<{ tokens: TokenResponse; delegationId: string }>;
  /** The form of a token request. */
  form(fields: Record<string, string>): URLSearchParams;
  close(): Promise<void>;
}

export async function openOAuthRig(options: OAuthRigOptions = {}): Promise<OAuthRig> {
  const { store, clock } = openTestStore();
  const audit = new MemoryAuditWriter();
  const config: OAuthConfig = {
    ...DEFAULT_TEST_OAUTH,
    ...options.ttl,
    clientRegistration: { ...DEFAULT_TEST_OAUTH.clientRegistration, ...options.registration },
  };
  const endpoints = oauthEndpoints(new URL(TEST_PUBLIC_URL));
  const now = (): number => clock.now().getTime();
  const logger = silentLogger;

  const rateLimiter = new MemoryRateLimiter(now);
  const clients = new ClientRegistry({
    repo: store.delegations,
    config: config.clientRegistration,
    audit,
    rateLimiter,
    clock,
    logger,
    fetchDocument: options.fetchDocument,
  });
  const authorization = new AuthorizationService({
    clients,
    repo: store.delegations,
    pending: new MemorySessionStore(now),
    audit,
    endpoints,
    clock,
    logger,
  });
  const lifetime = delegationLifetime(config.delegationMaxLifetimeSeconds, clock);
  const tokens = new TokenService({
    repo: store.delegations,
    users: store.users,
    missions: store.missions,
    clients,
    audit,
    rateLimiter,
    endpoints,
    config,
    clock,
    logger,
  });
  const delegations = new DelegationService({
    repo: store.delegations,
    missions: store.missions,
    clients,
    lifetime,
    audit,
    clock,
    logger,
  });
  const verifier = new DelegatedTokenVerifier({
    repo: store.delegations,
    users: store.users,
    clients,
    lifetime,
  });
  const ada = await store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'idp|ada',
    email: 'ada@example.com',
  });
  const bob = await store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'idp|bob',
    email: 'bob@example.com',
  });

  const rig: OAuthRig = {
    store,
    clock,
    audit,
    config,
    endpoints,
    clients,
    authorization,
    tokens,
    delegations,
    verifier,
    ada,
    bob,
    async registerClient(redirectUris = [LOOPBACK_REDIRECT], name = 'Test agent') {
      const registered = await clients.register({
        client_name: name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
      });
      return registered.client;
    },
    async grant(user, client, redirectUri = client.redirectUris[0] ?? LOOPBACK_REDIRECT) {
      const pkce = pkcePair();
      const consentId = await authorization.createPending(user, {
        client,
        redirectUri,
        state: 'state-1',
        codeChallenge: pkce.challenge,
      });
      const outcome = await authorization.decide(user, consentId, 'approve');
      if (outcome.outcome !== 'redirect')
        throw new Error(`consent not granted: ${outcome.outcome}`);
      const code = new URL(outcome.location).searchParams.get('code');
      if (!code || !outcome.delegationId) throw new Error('the redirect carries no code');
      return { code, pkce, redirectUri, delegationId: outcome.delegationId };
    },
    async issue(user, client) {
      const granted = await rig.grant(user, client);
      const tokenResponse = await tokens.exchangeCode(
        client,
        rig.form({
          grant_type: 'authorization_code',
          code: granted.code,
          code_verifier: granted.pkce.verifier,
          redirect_uri: granted.redirectUri,
        }),
      );
      return { tokens: tokenResponse, delegationId: granted.delegationId };
    },
    form: (fields) => new URLSearchParams(fields),
    close: () => store.close(),
  };
  return rig;
}
