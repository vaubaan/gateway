/**
 * `DelegatedTokenVerifier` — what a delegated access token is worth, right now.
 *
 * The token is opaque: its worth is its row. Every verification reads the
 * store, so a revocation (by the user, by the client, by an operator, by a
 * detected replay) and the removal of the user take effect on the very next
 * call — there is no cache to wait out and no signature that outlives the
 * decision.
 *
 * Two consumers, one answer:
 *
 * - the management door authenticates its callers with it, through
 *   `ManagementGate` (`verifyAccessToken` is the same answer in the MCP SDK's
 *   `OAuthTokenVerifier` contract, for a host that uses `requireBearerAuth`);
 * - the execution door recognises a delegated token with it so as to refuse
 *   it by kind (`wrong-credential-kind`) rather than as an unknown bearer
 *   (`resolve` is its `DelegatedTokenResolver` contract).
 */
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import type { DelegationContext } from '@vaubaan/gateway-core';

import type { DelegationsRepo } from '../store/repositories/delegations';
import type { UsersRepo } from '../store/repositories/users';
import type { OAuthEndpoints } from './endpoints';
import { digestOf, isAccessTokenShaped } from './secrets';

const MS_PER_SECOND = 1000;
/** Key under which the delegation rides `AuthInfo.extra` to the door's handlers. */
export const DELEGATION_AUTH_INFO_KEY = 'vaubaan.delegation';

export interface DelegatedTokenVerifierDeps {
  readonly repo: Pick<DelegationsRepo, 'findActiveAccessToken' | 'getClient'>;
  readonly users: Pick<UsersRepo, 'getById'>;
  readonly endpoints: OAuthEndpoints;
}

export class DelegatedTokenVerifier {
  constructor(private readonly deps: DelegatedTokenVerifierDeps) {}

  /**
   * The delegation behind a bearer, or `null`: not a delegated token, expired,
   * revoked, of a revoked delegation, or of a user who is no longer active.
   * A value of another shape is refused before anything is hashed or read.
   */
  async resolve(bearer: string): Promise<DelegationContext | null> {
    const token = bearer.trim();
    if (!isAccessTokenShaped(token)) return null;
    const found = await this.deps.repo.findActiveAccessToken(digestOf(token));
    if (!found) return null;
    const { delegation } = found;
    const user = await this.deps.users.getById(delegation.userId);
    if (!user || user.status !== 'active') return null;
    const client = await this.deps.repo.getClient(delegation.clientId);
    if (!client) return null;
    return {
      delegation_id: delegation.id,
      user_id: delegation.userId,
      client_id: client.clientId,
      scopes: delegation.scope.split(/\s+/).filter((scope) => scope !== ''),
      expires_at: found.token.expiresAt,
    };
  }

  /**
   * The MCP SDK's verifier contract: the `AuthInfo` of a valid token, with the
   * delegation under `extra[DELEGATION_AUTH_INFO_KEY]`, or an `invalid_token`
   * `OAuthError` (which the SDK's helpers turn into a 401 challenge). The
   * `token` field never carries the bearer further than the caller already had it.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const delegation = await this.resolve(token);
    if (!delegation) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown, expired or revoked token');
    }
    return {
      token,
      clientId: delegation.client_id,
      scopes: [...delegation.scopes],
      expiresAt: Math.floor(Date.parse(delegation.expires_at) / MS_PER_SECOND),
      resource: new URL(this.deps.endpoints.resource),
      resourceMetadataUrl: this.deps.endpoints.resourceMetadataUrl,
      extra: { [DELEGATION_AUTH_INFO_KEY]: delegation },
    };
  }
}
