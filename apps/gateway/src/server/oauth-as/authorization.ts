/**
 * The authorization endpoint's decisions (spec §0 "Delegation", §4.1 bis):
 * which client and redirect URI a request is about, whether the request is one
 * this server answers, the consent the user is shown, and what their answer
 * creates.
 *
 * Order, the one OAuth 2.1 §4.1.2.1 imposes: the client and its redirect URI
 * are established first, and until both are, nothing is ever sent to the
 * redirect URI — the human reads a page (`AuthorizationPageError`). Only then
 * are the other parameters judged, and their errors returned to the client
 * through the redirect (`AuthorizationRedirectError`).
 *
 * A consent is a server-side record bound to the user who was shown the
 * screen: the form posts back its id and a yes or a no, nothing else, so what
 * is granted is exactly what was displayed. One approval is one delegation —
 * one family of tokens — and one single-use authorization code.
 */
import { randomBytes } from 'node:crypto';

import type { AuditWriter } from '@vaubaan/gateway-core';

import type { SessionStore } from '../compose/ports';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type { DelegationsRepo } from '../store/repositories/delegations';
import type { OAuthClientRecord, UserRecord } from '../store/types';
import { isClientIdUrl } from './client-metadata-document';
import type { ClientRegistry, ClientView } from './clients';
import { isManagementResource, MANAGEMENT_SCOPE, type OAuthEndpoints } from './endpoints';
import { AuthorizationPageError, AuthorizationRedirectError } from './errors';
import { isCodeChallenge } from './pkce';
import { matchesRegisteredRedirect } from './redirect-uri';
import { digestOf, mintAuthorizationCode } from './secrets';

/** How long the user has to answer the consent screen. */
export const CONSENT_TTL_MS = 10 * 60_000;
/** How long the client has to redeem the code (OAuth 2.1 §4.1.2: short, at most ten minutes). */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const MAX_STATE_LENGTH = 1024;
const CONSENT_ID_BYTES = 32;
const CONSENT_ID = /^[A-Za-z0-9_-]{43}$/;
const BAD_REQUEST = 400;

/** An authorization request whose client, redirect URI and parameters were accepted. */
export interface AuthorizationRequest {
  readonly client: OAuthClientRecord;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
}

/** What the consent screen was shown, kept until the user answers. */
export interface PendingConsent {
  readonly userId: string;
  /** `oauth_clients.id`. */
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly createdAt: string;
}

function isPendingConsent(value: unknown): value is PendingConsent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    typeof v.clientId === 'string' &&
    typeof v.redirectUri === 'string' &&
    (v.state === null || typeof v.state === 'string') &&
    typeof v.codeChallenge === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export type ConsentDecision = 'approve' | 'deny';

export type ConsentOutcome =
  /**
   * The browser goes back to the client, with a code or with `access_denied`.
   * `delegationId` is the delegation an approval created (`null` on a denial).
   */
  | {
      readonly outcome: 'redirect';
      readonly location: string;
      readonly delegationId: string | null;
    }
  /** No such consent for this user: expired, already answered, or never theirs. */
  | { readonly outcome: 'expired' }
  /** The client stopped being usable between the screen and the answer. */
  | { readonly outcome: 'client-unavailable' };

export interface AuthorizationServiceDeps {
  readonly clients: ClientRegistry;
  readonly repo: DelegationsRepo;
  readonly pending: SessionStore;
  readonly audit: AuditWriter;
  readonly endpoints: OAuthEndpoints;
  readonly clock: Clock;
  readonly logger: Logger;
}

function key(id: string): string {
  return `oauth-consent:${id}`;
}

/** The redirect back to the client: its URI with the response parameters and the issuer (RFC 9207). */
export function authorizationResponseUrl(
  redirectUri: string,
  issuer: string,
  state: string | null,
  params: Readonly<Record<string, string>>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state !== null) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.href;
}

export class AuthorizationService {
  // single-process only — makes `take` atomic inside one process (the port has no
  // get-and-delete). A hosted `SessionStore` needs an atomic GETDEL instead.
  private readonly taking = new Set<string>();

  constructor(private readonly deps: AuthorizationServiceDeps) {}

  /**
   * Whether the request names a metadata document client: such a client is
   * resolved only once a user is signed in (`resolveClient` with a requester).
   */
  needsDocument(params: URLSearchParams): boolean {
    return isClientIdUrl(params.get('client_id') ?? '');
  }

  /**
   * The client and the redirect URI of a request, or a page for the human.
   * `requester` is the signed-in user's id; without one a metadata document
   * client is not resolved at all (the caller signs the user in first).
   */
  async resolveClient(
    params: URLSearchParams,
    requester: string | null,
  ): Promise<{ view: ClientView; redirectUri: string }> {
    const clientId = params.get('client_id');
    if (!clientId) {
      throw new AuthorizationPageError(
        BAD_REQUEST,
        'Invalid authorization request',
        'The request names no client. Start again from the application that sent you here.',
      );
    }
    const client = await this.findClient(clientId, requester);
    if (!client) {
      throw new AuthorizationPageError(
        BAD_REQUEST,
        'Unknown application',
        'This instance does not know the application that sent you here. Start the connection again from that application so that it registers.',
      );
    }
    const presented = params.get('redirect_uri');
    const redirectUri =
      presented ?? (client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null);
    if (!redirectUri || !matchesRegisteredRedirect(client.redirectUris, redirectUri)) {
      throw new AuthorizationPageError(
        BAD_REQUEST,
        'Invalid authorization request',
        'The address this request would return to is not one the application registered. Nothing was sent to it.',
      );
    }
    return { view: this.deps.clients.view(client), redirectUri };
  }

  private async findClient(
    clientId: string,
    requester: string | null,
  ): Promise<OAuthClientRecord | null> {
    if (!isClientIdUrl(clientId)) return this.deps.clients.find(clientId);
    if (requester === null) return null;
    try {
      return await this.deps.clients.resolveDocumentClient(clientId, requester);
    } catch (err) {
      throw new AuthorizationPageError(
        BAD_REQUEST,
        'Unknown application',
        `This instance could not accept the application that sent you here: ${
          err instanceof Error ? err.message : 'its description could not be read'
        }.`,
      );
    }
  }

  /**
   * Judges the rest of the request, once the redirect URI is trusted. Every
   * refusal here is the client's to read, through the redirect.
   */
  validate(
    client: OAuthClientRecord,
    redirectUri: string,
    params: URLSearchParams,
  ): AuthorizationRequest {
    const state = params.get('state');
    if (state !== null && state.length > MAX_STATE_LENGTH) {
      // Not echoed: an oversized state is not carried any further.
      throw new AuthorizationRedirectError('invalid_request', 'state is too long', false);
    }
    if (params.get('response_type') !== 'code') {
      throw new AuthorizationRedirectError(
        'unsupported_response_type',
        'response_type must be "code"',
      );
    }
    const codeChallenge = params.get('code_challenge');
    if (!codeChallenge) {
      throw new AuthorizationRedirectError('invalid_request', 'code_challenge is required (PKCE)');
    }
    if (params.get('code_challenge_method') !== 'S256') {
      throw new AuthorizationRedirectError(
        'invalid_request',
        'code_challenge_method must be "S256"',
      );
    }
    if (!isCodeChallenge(codeChallenge)) {
      throw new AuthorizationRedirectError(
        'invalid_request',
        'code_challenge is not a base64url-encoded SHA-256',
      );
    }
    const scope = params.get('scope');
    if (scope !== null && !scope.split(/\s+/).includes(MANAGEMENT_SCOPE)) {
      throw new AuthorizationRedirectError(
        'invalid_scope',
        `the only scope of this server is "${MANAGEMENT_SCOPE}"`,
      );
    }
    for (const resource of params.getAll('resource')) {
      if (!isManagementResource(this.deps.endpoints, resource)) {
        throw new AuthorizationRedirectError(
          'invalid_target',
          `this server only issues tokens for ${this.deps.endpoints.resource}`,
        );
      }
    }
    return { client, redirectUri, state, codeChallenge };
  }

  /** Records what the user is about to be shown and returns the id the form posts back. */
  async createPending(user: UserRecord, request: AuthorizationRequest): Promise<string> {
    const id = randomBytes(CONSENT_ID_BYTES).toString('base64url');
    const pending: PendingConsent = {
      userId: user.id,
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      state: request.state,
      codeChallenge: request.codeChallenge,
      createdAt: toIso(this.deps.clock.now()),
    };
    await this.deps.pending.set(key(id), pending, CONSENT_TTL_MS);
    return id;
  }

  /** Single use: the record is deleted whether or not the caller is the user it was shown to. */
  private async takePending(id: string, userId: string): Promise<PendingConsent | null> {
    if (!CONSENT_ID.test(id) || this.taking.has(id)) return null;
    this.taking.add(id);
    try {
      const record = await this.deps.pending.get(key(id));
      if (record === null) return null;
      await this.deps.pending.delete(key(id));
      return isPendingConsent(record) && record.userId === userId ? record : null;
    } finally {
      this.taking.delete(id);
    }
  }

  /**
   * The user's answer. An approval creates the delegation, writes its
   * `delegation-granted` entry, then mints the single-use code: a delegation
   * whose entry cannot be written is revoked and no code is issued.
   */
  async decide(
    user: UserRecord,
    consentId: string,
    decision: ConsentDecision,
  ): Promise<ConsentOutcome> {
    const { repo, clients, endpoints, clock, logger } = this.deps;
    const pending = await this.takePending(consentId, user.id);
    if (!pending) return { outcome: 'expired' };

    if (decision === 'deny') {
      logger.info('delegation denied by the user', { user_id: user.id });
      return {
        outcome: 'redirect',
        delegationId: null,
        location: authorizationResponseUrl(pending.redirectUri, endpoints.issuer, pending.state, {
          error: 'access_denied',
          error_description: 'The user refused the delegation.',
        }),
      };
    }

    // The screen was shown a moment ago; the client must still be usable now.
    const client = await clients.get(pending.clientId);
    if (
      !client ||
      clients.statusOf(client) !== 'approved' ||
      !matchesRegisteredRedirect(client.redirectUris, pending.redirectUri)
    ) {
      return { outcome: 'client-unavailable' };
    }

    const delegation = await repo.create({
      userId: user.id,
      clientId: client.id,
      scope: MANAGEMENT_SCOPE,
    });
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(clock.now()),
        user_id: user.id,
        act: 'delegation-granted',
        object: { type: 'delegation', id: delegation.id },
        before: null,
        after: {
          client_id: client.clientId,
          client_name: client.name,
          scope: delegation.scope,
          redirect_uri: pending.redirectUri,
          resource: endpoints.resource,
        },
        delegated_client_id: null,
      });
    } catch (err) {
      await repo.revoke(delegation.id);
      throw err;
    }
    const code = mintAuthorizationCode();
    await repo.createCode({
      delegationId: delegation.id,
      codeHash: digestOf(code),
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: toIso(new Date(clock.now().getTime() + AUTHORIZATION_CODE_TTL_MS)),
    });
    logger.info('delegation granted', {
      delegation_id: delegation.id,
      user_id: user.id,
      client_id: client.clientId,
    });
    return {
      outcome: 'redirect',
      delegationId: delegation.id,
      location: authorizationResponseUrl(pending.redirectUri, endpoints.issuer, pending.state, {
        code,
      }),
    };
  }
}
