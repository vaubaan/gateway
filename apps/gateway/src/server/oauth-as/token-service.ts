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
 * The missions the delegation issued are **not** revoked — the honest client's
 * agents may be at work on them — but the entry names the ones still running
 * (`after.missions_to_review`) and the Delegations page lists them for the
 * creator to review (`endDelegation`, `missionsToReview`).
 *
 * **One exception, the reuse window** (`oauth.refresh_reuse_window_seconds`,
 * 30 s by default, at most 60; ADR amendment of 2026-10-13). Two sessions of
 * one agent on one machine share one stored refresh token and may renew at the
 * same moment. The refresh token that was rotated *last* — the immediate
 * predecessor of the family's live head — presented again by the same client
 * within the window, is answered with a new pair: the head is rotated once
 * more and the family stays one chain. Any other replay (an older generation,
 * outside the window, by another client, a second time after the head moved
 * on) still revokes the family.
 *
 * **Every grant is one transaction of the store.** The code is spent and the
 * first pair written together (`redeemCode`); a refresh token is rotated and
 * the renewal's access token written together (`rotateRefreshToken`,
 * `rotateSuccessorOf`). A request refused by a check still spends its code. A
 * *write* that fails rolls the whole grant back — the code is unspent, the
 * presented refresh token is still the live head, no token exists that the
 * client never received — and the client is answered `server_error`, never
 * `invalid_grant`: it may send the same request again, and nothing about the
 * failure looks like a replay.
 *
 * **A delegation has an absolute lifetime** (`oauth.delegation_max_lifetime`,
 * 90 days by default; `delegation-lifetime.ts`). Past it nothing is issued:
 * the code grant and the refresh grant answer `invalid_grant`, and the client
 * starts the authorization flow again — the user consents again. Before it,
 * every token expires at the deadline at the latest, so a pair obtained the
 * day before does not carry the delegation thirty days further. Nothing is
 * written when the deadline passes: the state is derived wherever it is read.
 *
 * Nothing here logs a token or a code: entries name the delegation and the
 * client.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { RateLimiter } from '../compose/ports';
import type { OAuthConfig } from '../config/types';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import { REDEEM_DELEGATION_REVOKED, type DelegationsRepo } from '../store/repositories/delegations';
import type { MissionsRepo } from '../store/repositories/missions';
import type { UsersRepo } from '../store/repositories/users';
import type { DelegationRecord, DelegationRevokeReason, OAuthClientRecord } from '../store/types';
import type { ClientRegistry } from './clients';
import { delegationLifetime, type DelegationLifetime } from './delegation-lifetime';
import { endDelegation } from './delegations';
import {
  foreignResource,
  ONLY_SCOPE_MESSAGE,
  onlyResourceMessage,
  staysWithinManagement,
  type OAuthEndpoints,
} from './endpoints';
import { OAuthProtocolError, slowDown } from './errors';
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
/**
 * Renewals one delegation may obtain per window. Counted once the refresh token
 * presented is recognised as one of this client's — a caller that only knows a
 * `client_id`, which is public, spends nothing of it.
 */
export const RENEWALS_PER_DELEGATION = 120;
export const RENEWAL_WINDOW_MS = 60_000;

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
  /** Read only when a replay ends a delegation: the missions it issued are named in the entry. */
  readonly missions: Pick<MissionsRepo, 'listForCreator'>;
  readonly clients: ClientRegistry;
  readonly audit: AuditWriter;
  readonly rateLimiter: Pick<RateLimiter, 'take'>;
  readonly endpoints: OAuthEndpoints;
  readonly config: Pick<
    OAuthConfig,
    | 'accessTokenTtlSeconds'
    | 'refreshTokenTtlSeconds'
    | 'refreshReuseWindowSeconds'
    | 'delegationMaxLifetimeSeconds'
  >;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What the client is told once a delegation is past its absolute lifetime. */
export const DELEGATION_LIFETIME_REACHED =
  'this delegation reached its maximum lifetime; start the authorization flow again so that the user consents again';

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
    // Lenient decoding: what is not base64 yields no usable `id:secret` pair.
    const decoded = Buffer.from(authorization.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
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
  private readonly lifetime: DelegationLifetime;

  constructor(private readonly deps: TokenServiceDeps) {
    this.lifetime = delegationLifetime(deps.config.delegationMaxLifetimeSeconds, deps.clock);
  }

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
    // Read for the one check the transaction cannot make (the user, another repository).
    const found = await repo.findCode(hash);
    if (!found) throw invalidGrant('unknown authorization code');
    const userProblem = await this.userProblem(found.delegation);
    const redirectUri = form.get('redirect_uri');
    // Judged with the code spent, like every other refusal of this grant.
    const lifetimeProblem = this.lifetime.isOver(found.delegation)
      ? DELEGATION_LIFETIME_REACHED
      : null;

    const refreshToken = mintRefreshToken();
    const accessToken = mintAccessToken();
    const redeemed = await repo.redeemCode(
      hash,
      // Judged on the spent code: a request that fails here does not get a
      // second try with the same code. The answer is the refusal's description.
      (spent, delegation) => {
        if (delegation.clientId !== client.id) {
          return 'this authorization code was issued to another client';
        }
        if (redirectUri !== null && redirectUri !== spent.redirectUri) {
          return 'redirect_uri does not match the authorization request';
        }
        if (!verifyS256(verifier, spent.codeChallenge)) {
          return 'code_verifier does not match the code_challenge';
        }
        return userProblem ?? lifetimeProblem;
      },
      {
        refresh: this.refreshRow(found.delegation, refreshToken),
        access: this.accessRow(found.delegation, accessToken),
      },
    );
    switch (redeemed.outcome) {
      case 'unknown':
        throw invalidGrant('unknown authorization code');
      case 'expired':
        throw invalidGrant('this authorization code has expired');
      case 'replayed':
        // Two parties hold the code — also when they raced: the store answers
        // `replayed` to whichever came second.
        await this.revokeFamily(redeemed.delegation, 'authorization-code-replay');
        throw invalidGrant('this authorization code was already used');
      case 'refused':
        throw invalidGrant(
          redeemed.reason === REDEEM_DELEGATION_REVOKED
            ? 'this delegation was revoked'
            : redeemed.reason,
        );
      case 'issued':
        this.deps.logger.info('delegated tokens issued', {
          delegation_id: redeemed.delegation.id,
          client_id: client.clientId,
          grant: 'authorization_code',
        });
        return this.respond(redeemed.delegation, accessToken, refreshToken);
    }
  }

  /** `grant_type=refresh_token`: rotation, and the end of the family on a replay. */
  async refresh(client: OAuthClientRecord, form: URLSearchParams): Promise<TokenResponse> {
    const presented = form.get('refresh_token');
    if (!presented) throw new OAuthProtocolError('invalid_request', 'refresh_token is required');
    const scope = form.get('scope');
    if (scope !== null && !staysWithinManagement(scope)) {
      throw new OAuthProtocolError('invalid_scope', ONLY_SCOPE_MESSAGE);
    }
    this.checkResource(form);
    if (!isRefreshTokenShaped(presented)) throw invalidGrant('unknown refresh token');

    const { repo } = this.deps;
    const hash = digestOf(presented);
    const found = await repo.findRefreshToken(hash);
    if (!found) throw invalidGrant('unknown refresh token');
    if (found.token.replacedById !== null) return this.replayed(client, found.delegation, hash);
    if (found.delegation.clientId !== client.id) {
      throw invalidGrant('this refresh token was issued to another client');
    }
    await this.requireLiveDelegation(found.delegation);
    this.requireWithinLifetime(found.delegation, client);
    // The caller holds a refresh token of this client: from here on it spends
    // the delegation's own budget, and nobody else's.
    const budget = await this.deps.rateLimiter.take(
      `oauth:token:delegation:${found.delegation.id}`,
      RENEWALS_PER_DELEGATION,
      RENEWAL_WINDOW_MS,
    );
    if (!budget.allowed) throw slowDown(budget.retryAfterMs);

    const next = mintRefreshToken();
    const accessToken = mintAccessToken();
    const rotated = await repo.rotateRefreshToken(
      hash,
      this.refreshRow(found.delegation, next),
      this.accessRow(found.delegation, accessToken),
    );
    if (!rotated) {
      // Expired or revoked — or rotated by a concurrent request since the read above.
      const again = await repo.findRefreshToken(hash);
      if (again && again.token.replacedById !== null) {
        return this.replayed(client, again.delegation, hash);
      }
      throw invalidGrant('this refresh token has expired or was revoked');
    }
    this.deps.logger.info('delegated tokens issued', {
      delegation_id: found.delegation.id,
      client_id: client.clientId,
      grant: 'refresh_token',
    });
    return this.respond(found.delegation, accessToken, next);
  }

  /**
   * A refresh token presented after its rotation. Inside the reuse window, and
   * only for the token rotated last, the same client gets a new pair (the head
   * of the family is rotated again). Everything else is a replay: two parties
   * hold this family, whoever presents it, and the delegation ends.
   *
   * No rate limit is taken here, on purpose: nothing may stand between a
   * replay and the revocation it causes, and the path bounds itself — a token
   * is answered once (the head then moved on, and its next presentation
   * revokes the family).
   */
  private async replayed(
    client: OAuthClientRecord,
    delegation: DelegationRecord,
    hash: string,
  ): Promise<TokenResponse> {
    const { repo, config, clock, logger } = this.deps;
    const windowSeconds = config.refreshReuseWindowSeconds;
    // Past its lifetime a delegation issues nothing, reuse window or not: the
    // replay below still ends the family.
    const over = this.lifetime.isOver(delegation);
    if (windowSeconds > 0 && delegation.clientId === client.id && !over) {
      const next = mintRefreshToken();
      const accessToken = mintAccessToken();
      const rotatedSince = toIso(new Date(clock.now().getTime() - windowSeconds * MS_PER_SECOND));
      const reissued = await repo.rotateSuccessorOf(
        hash,
        rotatedSince,
        this.refreshRow(delegation, next),
        this.accessRow(delegation, accessToken),
      );
      if (reissued) {
        // A removed user gets nothing: the pair just written is never sent.
        await this.requireLiveDelegation(delegation);
        logger.info('delegated tokens issued', {
          delegation_id: delegation.id,
          client_id: client.clientId,
          grant: 'refresh_token',
          reuse_window: true,
        });
        return this.respond(delegation, accessToken, next);
      }
    }
    await this.revokeFamily(delegation, 'refresh-token-replay');
    throw invalidGrant('this refresh token was already used; the delegation is revoked');
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
        if (await repo.revokeAccessToken(found.token.id)) {
          this.deps.logger.info('access token revoked', {
            delegation_id: found.delegation.id,
            client_id: client.clientId,
          });
        }
      }
    }
  }

  /** RFC 8707: a `resource` parameter, when sent, must name the management door. */
  private checkResource(form: URLSearchParams): void {
    if (foreignResource(this.deps.endpoints, form.getAll('resource')) !== null) {
      throw new OAuthProtocolError('invalid_target', onlyResourceMessage(this.deps.endpoints));
    }
  }

  /** Why the user behind a delegation cannot be served, or `null` when they are active. */
  private async userProblem(delegation: DelegationRecord): Promise<string | null> {
    const user = await this.deps.users.getById(delegation.userId);
    return !user || user.status !== 'active'
      ? 'the user behind this delegation is no longer active'
      : null;
  }

  /** The delegation is active and the user who gave it still is one of the instance. */
  private async requireLiveDelegation(delegation: DelegationRecord): Promise<void> {
    if (delegation.status !== 'active') throw invalidGrant('this delegation was revoked');
    const problem = await this.userProblem(delegation);
    if (problem !== null) throw invalidGrant(problem);
  }

  /**
   * Refuses a renewal of a delegation past its absolute lifetime. Nothing is
   * written: the delegation reads `expired` wherever it is shown, its tokens
   * were minted to expire at the deadline, and the user's next consent creates
   * a new delegation.
   */
  private requireWithinLifetime(delegation: DelegationRecord, client: OAuthClientRecord): void {
    if (!this.lifetime.isOver(delegation)) return;
    this.deps.logger.info('delegated tokens refused: the delegation reached its lifetime', {
      delegation_id: delegation.id,
      client_id: client.clientId,
      consented_at: delegation.createdAt,
    });
    throw invalidGrant(DELEGATION_LIFETIME_REACHED);
  }

  /** Expiry of a token minted now: its own lifetime, never past the delegation's deadline. */
  private expiry(delegation: DelegationRecord, ttlSeconds: number): string {
    return toIso(this.lifetime.expiryOf(delegation, ttlSeconds));
  }

  private refreshRow(
    delegation: DelegationRecord,
    refreshToken: string,
  ): { tokenHash: string; expiresAt: string } {
    return {
      tokenHash: digestOf(refreshToken),
      expiresAt: this.expiry(delegation, this.deps.config.refreshTokenTtlSeconds),
    };
  }

  private accessRow(
    delegation: DelegationRecord,
    accessToken: string,
  ): { tokenHash: string; expiresAt: string } {
    return {
      tokenHash: digestOf(accessToken),
      expiresAt: this.expiry(delegation, this.deps.config.accessTokenTtlSeconds),
    };
  }

  /** The RFC 6749 §5.1 body of a pair the store already holds. */
  private async respond(
    delegation: DelegationRecord,
    accessToken: string,
    refreshToken: string,
  ): Promise<TokenResponse> {
    await this.purgeNowAndThen();
    // What the access token is really worth: its row expires at the delegation's
    // deadline when that comes before its own lifetime.
    const untilDeadline = Math.floor(
      (this.lifetime.deadlineOf(delegation).getTime() - this.deps.clock.now().getTime()) /
        MS_PER_SECOND,
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.min(this.deps.config.accessTokenTtlSeconds, untilDeadline)),
      refresh_token: refreshToken,
      scope: delegation.scope,
    };
  }

  /**
   * Revokes the delegation with every token under it, once, and leaves the
   * entry that says why (`endDelegation`). The entry is in the name of the user
   * who gave the delegation and names the client: nobody else is behind the act.
   */
  private async revokeFamily(
    delegation: DelegationRecord,
    reason: DelegationRevokeReason,
  ): Promise<void> {
    // Another request may have revoked it first: its entry is the one that stands.
    await endDelegation(this.deps, delegation.id, {
      reason,
      actorId: delegation.userId,
      viaClient: true,
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
