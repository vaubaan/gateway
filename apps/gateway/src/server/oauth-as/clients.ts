/**
 * OAuth clients of the management door: how one comes to exist (dynamic
 * registration, RFC 7591; or a Client ID Metadata Document), whether it may
 * ask users for a delegation, and the operator's decisions about it.
 *
 * **A client is never trusted for what it says of itself.** Its name is
 * whatever the registering party typed; the consent screen shows where the
 * authorization code will go, and the registration policy decides whether an
 * unknown client may reach a consent screen at all:
 *
 *   status = operator decision, when there is one
 *          = else what the configured policy says of this client *now*
 *
 * The policy is evaluated at every use, never stored: tightening the policy
 * takes effect at once on every client no operator decided about.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { RateLimiter } from '../compose/ports';
import type { OAuthConfig } from '../config/types';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type { DelegationsRepo } from '../store/repositories/delegations';
import {
  TOKEN_ENDPOINT_AUTH_METHODS,
  type ClientOperatorDecision,
  type DelegationRecord,
  type OAuthClientRecord,
  type TokenEndpointAuthMethod,
} from '../store/types';
import {
  checkClientIdUrl,
  cleanClientName,
  cleanClientUri,
  ClientDocumentError,
  parseClientDocument,
  type ClientDocumentFetcher,
} from './client-metadata-document';
import { recordDelegationEnded } from './delegations';
import { MANAGEMENT_SCOPE, SUPPORTED_GRANT_TYPES, SUPPORTED_RESPONSE_TYPES } from './endpoints';
import { OAuthProtocolError } from './errors';
import { checkRedirectUri, isLoopbackOnly } from './redirect-uri';
import { digestOf, mintClientId, mintClientSecret } from './secrets';

/** `approved`: may ask users for a delegation. `pending`: waits for an operator. */
export type ClientStatus = 'approved' | 'pending' | 'disabled';

export interface ClientView {
  readonly client: OAuthClientRecord;
  readonly status: ClientStatus;
  /** Who made the status what it is: an operator, or the registration policy. */
  readonly decidedBy: 'operator' | 'policy';
  /** Every redirect URI stays on the loopback interface of the user's machine. */
  readonly loopbackOnly: boolean;
}

/** The RFC 7591 response of a successful registration. The secret appears here once. */
export interface RegisteredClient {
  readonly client: OAuthClientRecord;
  readonly status: ClientStatus;
  readonly clientSecret: string | null;
}

export interface ClientRegistryDeps {
  readonly repo: DelegationsRepo;
  readonly config: OAuthConfig['clientRegistration'];
  readonly audit: AuditWriter;
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent: metadata documents cannot be fetched, whatever the configuration says. */
  readonly fetchDocument?: ClientDocumentFetcher;
}

export const MAX_REDIRECT_URIS = 10;
export const UNNAMED_CLIENT = 'Unnamed client';
/** An undecided client that nobody ever consented to is forgotten after this long. */
export const UNUSED_CLIENT_RETENTION_MS = 30 * 86_400_000;
/**
 * A dynamic registration that waits for an operator is forgotten after this long
 * (security review 2026-10-15, external M2): the operator's page is not a list an
 * anonymous caller can grow for ever.
 */
export const PENDING_REGISTRATION_TTL_MS = 86_400_000;
/** Dynamic registrations waiting for an operator at once; one more is refused. */
export const MAX_PENDING_REGISTRATIONS = 50;
/** Metadata documents one user may make the instance fetch, per window. */
export const DOCUMENT_FETCHES_PER_WINDOW = 10;
export const DOCUMENT_FETCH_WINDOW_MS = 60_000;

const MS_PER_SECOND = 1000;

function invalidMetadata(description: string): OAuthProtocolError {
  return new OAuthProtocolError('invalid_client_metadata', description);
}

function stringList(value: unknown, field: string): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidMetadata(`${field} must be a list of strings`);
  }
  return value;
}

function isAuthMethod(raw: unknown): raw is TokenEndpointAuthMethod {
  return (
    typeof raw === 'string' && (TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(raw)
  );
}

export class ClientRegistry {
  constructor(private readonly deps: ClientRegistryDeps) {}

  /** What the configured policy and the operator say of this client, now. */
  statusOf(client: OAuthClientRecord): ClientStatus {
    return this.view(client).status;
  }

  view(client: OAuthClientRecord): ClientView {
    const loopbackOnly = isLoopbackOnly(client.redirectUris);
    if (client.operatorDecision !== null) {
      return { client, status: client.operatorDecision, decidedBy: 'operator', loopbackOnly };
    }
    return { client, status: this.policyStatus(loopbackOnly), decidedBy: 'policy', loopbackOnly };
  }

  private policyStatus(loopbackOnly: boolean): ClientStatus {
    const { policy, autoApproveLoopback } = this.deps.config;
    if (policy === 'open') return 'approved';
    if (policy === 'closed') return 'pending';
    return autoApproveLoopback && loopbackOnly ? 'approved' : 'pending';
  }

  async find(clientId: string): Promise<OAuthClientRecord | null> {
    return this.deps.repo.getClientByClientId(clientId);
  }

  async get(id: string): Promise<OAuthClientRecord | null> {
    return this.deps.repo.getClient(id);
  }

  /** Every client with its status, most recently registered first. */
  async list(): Promise<ClientView[]> {
    return (await this.deps.repo.listClients()).map((client) => this.view(client));
  }

  /**
   * Dynamic client registration (RFC 7591). The caller is anybody who can
   * reach the endpoint: everything in `metadata` is a claim, validated and
   * bounded here, and what it yields is a client that may still have to wait
   * for an operator.
   */
  async register(metadata: unknown): Promise<RegisteredClient> {
    if (this.deps.config.policy === 'closed') {
      throw new OAuthProtocolError(
        'access_denied',
        'Client registration is closed on this instance. Ask an operator.',
        403,
      );
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw invalidMetadata('the registration request must be a JSON object');
    }
    const body = metadata as Record<string, unknown>;

    const redirectUris = stringList(body.redirect_uris, 'redirect_uris');
    if (!redirectUris || redirectUris.length === 0) {
      throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris is required');
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthProtocolError(
        'invalid_redirect_uri',
        `at most ${MAX_REDIRECT_URIS} redirect URIs may be registered`,
      );
    }
    for (const uri of redirectUris) {
      const check = checkRedirectUri(uri);
      if (!check.ok) {
        throw new OAuthProtocolError('invalid_redirect_uri', `a redirect URI ${check.reason}`);
      }
    }

    // RFC 7591 §2: an omitted method means `client_secret_basic`.
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!isAuthMethod(method)) {
      throw invalidMetadata(
        `token_endpoint_auth_method must be one of ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}`,
      );
    }
    const grantTypes = stringList(body.grant_types, 'grant_types');
    if (grantTypes) {
      const unsupported = grantTypes.filter(
        (grant) => !(SUPPORTED_GRANT_TYPES as readonly string[]).includes(grant),
      );
      if (unsupported.length > 0 || !grantTypes.includes('authorization_code')) {
        throw invalidMetadata(
          `grant_types must include authorization_code and only name ${SUPPORTED_GRANT_TYPES.join(', ')}`,
        );
      }
    }
    const responseTypes = stringList(body.response_types, 'response_types');
    if (
      responseTypes &&
      responseTypes.some((type) => !(SUPPORTED_RESPONSE_TYPES as readonly string[]).includes(type))
    ) {
      throw invalidMetadata(`response_types may only name ${SUPPORTED_RESPONSE_TYPES.join(', ')}`);
    }

    const now = this.deps.clock.now();
    // Whoever registers clients that nobody uses does not grow the table for ever.
    await this.deps.repo.deleteUnusedClients(
      toIso(new Date(now.getTime() - UNUSED_CLIENT_RETENTION_MS)),
    );
    if (this.policyStatus(isLoopbackOnly(redirectUris)) === 'pending') {
      await this.makeRoomForPending(now);
    }
    const clientSecret = method === 'none' ? null : mintClientSecret();
    const client = await this.deps.repo.registerClient({
      clientId: mintClientId(),
      name: cleanClientName(body.client_name) ?? UNNAMED_CLIENT,
      clientSecretHash: clientSecret === null ? null : digestOf(clientSecret),
      redirectUris,
      registration: 'dynamic',
      tokenEndpointAuthMethod: method,
      clientUri: cleanClientUri(body.client_uri),
    });
    const status = this.statusOf(client);
    this.deps.logger.info('oauth client registered', {
      client_id: client.clientId,
      client_name: client.name,
      status,
      auth_method: method,
    });
    return { client, status, clientSecret };
  }

  /**
   * Expires the dynamic registrations that waited for an operator longer than
   * `PENDING_REGISTRATION_TTL_MS`, then refuses a new one while
   * `MAX_PENDING_REGISTRATIONS` still wait.
   */
  private async makeRoomForPending(now: Date): Promise<void> {
    const waiting = (await this.deps.repo.listClients())
      .map((client) => this.view(client))
      .filter(
        (view) =>
          view.status === 'pending' &&
          view.decidedBy === 'policy' &&
          view.client.registration === 'dynamic',
      );
    const cutoff = toIso(new Date(now.getTime() - PENDING_REGISTRATION_TTL_MS));
    const expired = waiting.filter((view) => view.client.createdAt < cutoff);
    const removed =
      expired.length > 0
        ? await this.deps.repo.deleteUndecidedClients(expired.map((view) => view.client.id))
        : 0;
    if (removed > 0) this.deps.logger.info('pending oauth registrations expired', { removed });
    if (waiting.length - removed >= MAX_PENDING_REGISTRATIONS) {
      this.deps.logger.warn('oauth registration refused: too many registrations wait', {
        waiting: waiting.length - removed,
      });
      throw new OAuthProtocolError(
        'access_denied',
        'Too many registrations are waiting for an administrator of this instance. Try again later, or ask one.',
        429,
      );
    }
  }

  /**
   * The client behind a metadata document URL: the stored one while its
   * document is fresh, else the document fetched again. `requester` keys the
   * rate limit of the fetches one user may cause.
   */
  async resolveDocumentClient(clientId: string, requester: string): Promise<OAuthClientRecord> {
    const { config, fetchDocument, repo, clock } = this.deps;
    if (!config.metadataDocuments || !fetchDocument) {
      throw new ClientDocumentError('metadata documents are not accepted on this instance');
    }
    const url = checkClientIdUrl(clientId);
    if (!(url instanceof URL)) throw new ClientDocumentError(`the client id ${url.reason}`);

    const existing = await repo.getClientByClientId(url.href);
    const now = clock.now();
    if (existing?.metadataExpiresAt && existing.metadataExpiresAt > toIso(now)) return existing;
    if (!existing && config.policy === 'closed') {
      throw new ClientDocumentError('client registration is closed on this instance');
    }

    const limit = await this.deps.rateLimiter.take(
      `oauth:client-document:${requester}`,
      DOCUMENT_FETCHES_PER_WINDOW,
      DOCUMENT_FETCH_WINDOW_MS,
    );
    if (!limit.allowed) {
      throw new ClientDocumentError('too many client documents were fetched; try again shortly');
    }
    let document;
    try {
      document = parseClientDocument(url, await fetchDocument(url));
    } catch (err) {
      this.deps.logger.warn('client metadata document refused', {
        client_id: url.href,
        reason: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof ClientDocumentError) throw err;
      throw new ClientDocumentError('the document could not be fetched');
    }
    const metadataExpiresAt = toIso(
      new Date(now.getTime() + document.maxAgeSeconds * MS_PER_SECOND),
    );
    if (existing) {
      return repo.updateClientDocument(existing.id, {
        name: document.name,
        redirectUris: document.redirectUris,
        clientUri: document.clientUri,
        metadataExpiresAt,
      });
    }
    const client = await repo.registerClient({
      clientId: url.href,
      name: document.name,
      redirectUris: document.redirectUris,
      registration: 'metadata-document',
      tokenEndpointAuthMethod: 'none',
      clientUri: document.clientUri,
      metadataExpiresAt,
    });
    this.deps.logger.info('oauth client registered from its metadata document', {
      client_id: client.clientId,
      client_name: client.name,
      status: this.statusOf(client),
    });
    return client;
  }

  /**
   * The operator's decision (Administration → OAuth clients). Disabling a
   * client ends every delegation it holds: the decision and the revocations
   * (with their tokens) are one transaction of the store, so a disabled client
   * never keeps a live delegation. Each delegation then leaves its own entry
   * so that the user who gave it finds it in their audit. `actorId` is the
   * operator (`auditActorId`).
   */
  async decide(
    actorId: string,
    id: string,
    decision: ClientOperatorDecision,
  ): Promise<{ client: OAuthClientRecord; revoked: readonly DelegationRecord[] } | null> {
    const { repo, audit, clock } = this.deps;
    const before = await repo.getClient(id);
    if (!before) return null;
    const previous = this.statusOf(before);
    const { client, revoked } =
      decision === 'disabled'
        ? await repo.disableClient(id, actorId)
        : { client: await repo.decideClient(id, decision, actorId), revoked: [] };
    await audit.write({
      kind: 'admin',
      ts: toIso(clock.now()),
      user_id: actorId,
      act: decision === 'approved' ? 'oauth-client-approved' : 'oauth-client-disabled',
      object: { type: 'oauth-client', id: client.id },
      before: { status: previous },
      after: {
        status: decision,
        client_id: client.clientId,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        ...(decision === 'disabled' ? { delegations_revoked: revoked.length } : {}),
      },
      delegated_client_id: null,
    });
    for (const delegation of revoked) {
      await recordDelegationEnded(this.deps, delegation, client, {
        reason: 'operator',
        actorId,
        viaClient: false,
      });
    }
    this.deps.logger.info('oauth client decided', {
      client_id: client.clientId,
      decision,
      delegations_revoked: revoked.length,
    });
    return { client, revoked };
  }
}

/** The RFC 7591 §3.2.1 body of a registration response. */
export function registrationResponse(registered: RegisteredClient): Record<string, unknown> {
  const { client, clientSecret } = registered;
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / MS_PER_SECOND),
    ...(clientSecret === null
      ? {}
      : // 0: the secret does not expire (RFC 7591 §3.2.1).
        { client_secret: clientSecret, client_secret_expires_at: 0 }),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: [...SUPPORTED_GRANT_TYPES],
    response_types: [...SUPPORTED_RESPONSE_TYPES],
    scope: MANAGEMENT_SCOPE,
    ...(client.clientUri ? { client_uri: client.clientUri } : {}),
  };
}
