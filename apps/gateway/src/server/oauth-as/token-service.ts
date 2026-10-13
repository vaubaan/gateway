/**
 * The token endpoint's work (spec §6 "short, traceable delegated tokens"):
 * client authentication, the authorization-code grant, the refresh grant with
 * rotation, and revocation (RFC 7009).
 *
 * What is issued:
 *
 *   access token   opaque, `oauth.access_token_ttl` (15 minutes by default),
 *                  a row keyed by its digest — revocable at once, checked at
 *                  every call of the management door
 *   refresh token  opaque, `oauth.refresh_token_ttl`, single use: each
 *                  renewal revokes it and issues its successor
 *
 * **Replay ends the delegation.** An authorization code or a refresh token
 * that comes back after it was used means two parties hold it. The server
 * cannot tell the thief from the client, so it revokes the whole family — the
 * delegation with every token issued under it — and writes a
 * `delegation-revoked` entry (RFC 9700 §2.2.2, §4.14; the orchestrator's
 * decision for v5). The user grants a new delegation if the client was honest.
 *
 * Nothing here logs a token or a code: entries name the delegation and the
 * client.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { OAuthConfig } from '../config/types';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type { DelegationsRepo } from '../store/repositories/delegations';
import type { UsersRepo } from '../store/repositories/users';
import type { DelegationRecord, DelegationRevokeReason, OAuthClientRecord } from '../store/types';
import type { ClientRegistry } from './clients';
import { isManagementResource, MANAGEMENT_SCOPE, type OAuthEndpoints } from './endpoints';
import { OAuthProtocolError } from './errors';
import { verifyS256 } from './pkce';
import {
  digestOf,
  isAccessTokenShaped,
  isAuthorizationCodeShaped,
  isRefreshTokenShaped,
  matchesDigest,
  mintAccessToken,
  mintRefreshToken,
} from './secrets';

const MS_PER_SECOND = 1000;
/** Expired codes and tokens are swept at most this often… */
export const PURGE_INTERVAL_MS = 3_600_000;
/** …once they have been expired for this long (a replayed token is still recognised until then). */
export const PURGE_GRACE_MS = 86_400_000;

/** RFC 6749 §5.1. */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

/** How a client presented itself at an endpoint. */
export interface ClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string | null;
  /** `basic`: the challenge of a failed authentication names the Basic scheme (RFC 6749 §5.2). */
  readonly via: 'basic' | 'body';
}

export interface TokenServiceDeps {
  readonly repo: DelegationsRepo;
  readonly users: Pick<UsersRepo, 'getById'>;
  readonly clients: ClientRegistry;
  readonly audit: AuditWriter;
  readonly endpoints: OAuthEndpoints;
  readonly config: Pick<OAuthConfig, 'accessTokenTtlSeconds' | 'refreshTokenTtlSeconds'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

function invalidGrant(description: string): OAuthProtocolError {
  return new OAuthProtocolError('invalid_grant', description);
}

/**
 * The client credentials of a request: HTTP Basic (RFC 6749 §2.3.1, both parts
 * form-urlencoded) or the `client_id` / `client_secret` body parameters. Both
 * at once is a malformed request.
 */
export function clientCredentialsOf(headers: Headers, form: URLSearchParams): ClientCredentials {
  const authorization = headers.get('authorization');
  const bodyId = form.get('client_id');
  const bodySecret = form.get('client_secret');
  if (authorization && /^basic\s/i.test(authorization)) {
    if (bodySecret !== null) {
      throw new OAuthProtocolError(
        'invalid_request',
        'client credentials were sent both in the Authorization header and in the body',
      );
    }
    let decoded: string;
    try {
      decoded = Buffer.from(authorization.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const colon = decoded.indexOf(':');
    try {
      if (colon > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
          clientSecret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
          via: 'basic',
        };
      }
    } catch {
      // Falls through to the refusal below.
    }
    throw new OAuthProtocolError('invalid_client', 'malformed Basic client credentials');
  }
  if (!bodyId) throw new OAuthProtocolError('invalid_request', 'client_id is required');
  return { clientId: bodyId, clientSecret: bodySecret, via: 'body' };
}

export class TokenService {
  // single-process only — when the last sweep ran. A replica that sweeps again
  // deletes nothing more: the purge is idempotent.
  private lastPurgeAt = 0;

  constructor(private readonly deps: TokenServiceDeps) {}

  /**
   * Who is calling. A public client is identified by its id alone (its proof
   * is the PKCE verifier or the refresh token it presents); a confidential
   * client must also present its secret. A client that is not approved — by
   * an operator or by the registration policy, as of now — gets nothing.
   */
  async authenticateClient(credentials: ClientCredentials): Promise<OAuthClientRecord> {
    const client = await this.deps.clients.find(credentials.clientId);
    if (!client) throw new OAuthProtocolError('invalid_client', 'unknown client');
    if (client.clientSecretHash !== null) {
      if (
        credentials.clientSecret === null ||
        !matchesDigest(credentials.clientSecret, client.clientSecretHash)
      ) {
        throw new OAuthProtocolError('invalid_client', 'client authentication failed');
      }
    }
    if (this.deps.clients.statusOf(client) !== 'approved') {
      throw new OAuthProtocolError(
        'unauthorized_client',
        'this client is not approved on this instance',
      );
    }
    return client;
  }

  /** `grant_type=authorization_code`: the code, once, against its PKCE verifier. */
  async exchangeCode(client: OAuthClientRecord, form: URLSearchParams): Promise<TokenResponse> {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    if (!code) throw new OAuthProtocolError('invalid_request', 'code is required');
    if (!verifier) throw new OAuthProtocolError('invalid_request', 'code_verifier is required');
    this.checkResource(form);
    if (!isAuthorizationCodeShaped(code)) throw invalidGrant('unknown authorization code');

    const { repo } = this.deps;
    const hash = digestOf(code);
    const found = await repo.findCode(hash);
    if (!found) throw invalidGrant('unknown authorization code');
    if (found.token.consumedAt !== null) {
      await this.revokeFamily(found.delegation, 'authorization-code-replay');
      throw invalidGrant('this authorization code was already used');
    }
    const consumed = await repo.consumeCode(hash);
    if (!consumed) {
      // Expired — or consumed by a concurrent request since the read above.
      const again = await repo.findCode(hash);
      if (again && again.token.consumedAt !== null) {
        await this.revokeFamily(again.delegation, 'authorization-code-replay');
        throw invalidGrant('this authorization code was already used');
      }
      throw invalidGrant('this authorization code has expired');
    }

    // From here on the code is spent: a request that fails a check below does
    // not get a second try with the same code.
    const { delegation } = found;
    if (delegation.clientId !== client.id) {
      throw invalidGrant('this authorization code was issued to another client');
    }
    const redirectUri = form.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== consumed.redirectUri) {
      throw invalidGrant('redirect_uri does not match the authorization request');
    }
    if (!verifyS256(verifier, consumed.codeChallenge)) {
      throw invalidGrant('code_verifier does not match the code_challenge');
    }
    await this.requireLiveDelegation(delegation);

    const refreshToken = mintRefreshToken();
    await repo.createRefreshToken({
      delegationId: delegation.id,
      tokenHash: digestOf(refreshToken),
      expiresAt: this.expiry(this.deps.config.refreshTokenTtlSeconds),
    });
    this.deps.logger.info('delegated tokens issued', {
      delegation_id: delegation.id,
      client_id: client.clientId,
      grant: 'authorization_code',
    });
    return this.respond(delegation, refreshToken);
  }

  /** `grant_type=refresh_token`: rotation, and the end of the family on a replay. */
  async refresh(client: OAuthClientRecord, form: URLSearchParams): Promise<TokenResponse> {
    const presented = form.get('refresh_token');
    if (!presented) throw new OAuthProtocolError('invalid_request', 'refresh_token is required');
    const scope = form.get('scope');
    if (scope !== null && scope.split(/\s+/).some((s) => s !== '' && s !== MANAGEMENT_SCOPE)) {
      throw new OAuthProtocolError(
        'invalid_scope',
        `the only scope of this server is "${MANAGEMENT_SCOPE}"`,
      );
    }
    this.checkResource(form);
    if (!isRefreshTokenShaped(presented)) throw invalidGrant('unknown refresh token');

    const { repo } = this.deps;
    const hash = digestOf(presented);
    const found = await repo.findRefreshToken(hash);
    if (!found) throw invalidGrant('unknown refresh token');
    if (found.token.replacedById !== null) {
      // Used before: whoever presents it now, two parties hold this family.
      await this.revokeFamily(found.delegation, 'refresh-token-replay');
      throw invalidGrant('this refresh token was already used; the delegation is revoked');
    }
    if (found.delegation.clientId !== client.id) {
      throw invalidGrant('this refresh token was issued to another client');
    }
    await this.requireLiveDelegation(found.delegation);

    const next = mintRefreshToken();
    const rotated = await repo.rotateRefreshToken(hash, {
      tokenHash: digestOf(next),
      expiresAt: this.expiry(this.deps.config.refreshTokenTtlSeconds),
    });
    if (!rotated) {
      // Expired or revoked — or rotated by a concurrent request since the read above.
      const again = await repo.findRefreshToken(hash);
      if (again && again.token.replacedById !== null) {
        await this.revokeFamily(again.delegation, 'refresh-token-replay');
        throw invalidGrant('this refresh token was already used; the delegation is revoked');
      }
      throw invalidGrant('this refresh token has expired or was revoked');
    }
    this.deps.logger.info('delegated tokens issued', {
      delegation_id: found.delegation.id,
      client_id: client.clientId,
      grant: 'refresh_token',
    });
    return this.respond(found.delegation, next);
  }

  /**
   * RFC 7009. A refresh token of this client ends its delegation (the client
   * signs out); an access token is revoked alone. A token that is unknown,
   * already dead or another client's changes nothing, and the caller is not
   * told which.
   */
  async revoke(client: OAuthClientRecord, form: URLSearchParams): Promise<void> {
    const token = form.get('token');
    if (!token) throw new OAuthProtocolError('invalid_request', 'token is required');
    const { repo } = this.deps;
    if (isRefreshTokenShaped(token)) {
      const found = await repo.findRefreshToken(digestOf(token));
      if (found && found.delegation.clientId === client.id) {
        await this.revokeFamily(found.delegation, 'client');
      }
      return;
    }
    if (isAccessTokenShaped(token)) {
      const found = await repo.findActiveAccessToken(digestOf(token));
      if (found && found.delegation.clientId === client.id) {
        await repo.revokeAccessToken(found.token.id);
      }
    }
  }

  /** RFC 8707: a `resource` parameter, when sent, must name the management door. */
  private checkResource(form: URLSearchParams): void {
    for (const resource of form.getAll('resource')) {
      if (!isManagementResource(this.deps.endpoints, resource)) {
        throw new OAuthProtocolError(
          'invalid_target',
          `this server only issues tokens for ${this.deps.endpoints.resource}`,
        );
      }
    }
  }

  /** The delegation is active and the user who gave it still is one of the instance. */
  private async requireLiveDelegation(delegation: DelegationRecord): Promise<void> {
    if (delegation.status !== 'active') throw invalidGrant('this delegation was revoked');
    const user = await this.deps.users.getById(delegation.userId);
    if (!user || user.status !== 'active') {
      throw invalidGrant('the user behind this delegation is no longer active');
    }
  }

  private expiry(ttlSeconds: number): string {
    return toIso(new Date(this.deps.clock.now().getTime() + ttlSeconds * MS_PER_SECOND));
  }

  private async respond(
    delegation: DelegationRecord,
    refreshToken: string,
  ): Promise<TokenResponse> {
    const { repo, config } = this.deps;
    const accessToken = mintAccessToken();
    try {
      await repo.createAccessToken({
        delegationId: delegation.id,
        tokenHash: digestOf(accessToken),
        expiresAt: this.expiry(config.accessTokenTtlSeconds),
      });
    } catch {
      // The delegation was revoked between the grant's checks and this write.
      throw invalidGrant('this delegation was revoked');
    }
    await this.purgeNowAndThen();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: delegation.scope,
    };
  }

  /**
   * Revokes the delegation with every token under it, once, and leaves the
   * entry that says why. The entry is in the name of the user who gave the
   * delegation and names the client: nobody else is behind the act.
   */
  private async revokeFamily(
    delegation: DelegationRecord,
    reason: DelegationRevokeReason,
  ): Promise<void> {
    const { repo, audit, clock, logger } = this.deps;
    // Another request may have revoked it first: its entry is the one that stands.
    if (!(await repo.revokeIfActive(delegation.id, reason))) return;
    const client = await repo.getClient(delegation.clientId);
    const log = reason === 'client' ? logger.info.bind(logger) : logger.warn.bind(logger);
    log('delegation revoked', {
      delegation_id: delegation.id,
      user_id: delegation.userId,
      client_id: client?.clientId ?? null,
      reason,
    });
    await audit.write({
      kind: 'admin',
      ts: toIso(clock.now()),
      user_id: delegation.userId,
      act: 'delegation-revoked',
      object: { type: 'delegation', id: delegation.id },
      before: { status: 'active' },
      after: {
        status: 'revoked',
        reason,
        client_id: client?.clientId ?? null,
        client_name: client?.name ?? null,
      },
      delegated_client_id: client?.clientId ?? null,
    });
  }

  private async purgeNowAndThen(): Promise<void> {
    const now = this.deps.clock.now().getTime();
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    try {
      await this.deps.repo.purgeExpired(toIso(new Date(now - PURGE_GRACE_MS)));
    } catch (err) {
      this.deps.logger.warn('expired oauth codes and tokens were not swept', { err });
    }
  }
}
