/**
 * `DelegatedTokenVerifier` — what a delegated access token is worth, right now.
 *
 * The token is opaque: its worth is its row. Every verification reads the
 * store, so a revocation (by the user, by the client, by an operator, by a
 * detected replay) and the removal of the user take effect on the very next
 * call — there is no cache to wait out and no signature that outlives the
 * decision. The **client's status** is evaluated at every verification too
 * (`ClientRegistry.statusOf`: the operator's decision, else the registration
 * policy as configured now): a token of a client that is no longer approved
 * is worth nothing, whatever its expiry says.
 *
 * Two consumers, one answer:
 *
 * - the management door authenticates its callers with it, through
 *   `ManagementGate.admit`, which is also where the scope is checked;
 * - the execution door recognises a delegated token with it so as to refuse
 *   it by kind (`wrong-credential-kind`) rather than as an unknown bearer
 *   (`resolve` is its `DelegatedTokenResolver` contract).
 */
import type { DelegationContext } from '@vaubaan/gateway-core';

import type { DelegationsRepo } from '../store/repositories/delegations';
import type { UsersRepo } from '../store/repositories/users';
import type { ClientRegistry } from './clients';
import { scopesOf } from './endpoints';
import { digestOf, isAccessTokenShaped } from './secrets';

export interface DelegatedTokenVerifierDeps {
  readonly repo: Pick<DelegationsRepo, 'findActiveAccessToken' | 'getClient'>;
  readonly users: Pick<UsersRepo, 'getById'>;
  /** What the operator and the registration policy say of a client, now. */
  readonly clients: Pick<ClientRegistry, 'statusOf'>;
}

export class DelegatedTokenVerifier {
  constructor(private readonly deps: DelegatedTokenVerifierDeps) {}

  /**
   * The delegation behind a bearer, or `null`: not a delegated token, expired,
   * revoked, of a revoked delegation, of a user who is no longer active, or
   * of a client that is not approved as of now (disabled, or left pending by a
   * registration policy tightened since the token was issued).
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
    if (!client || this.deps.clients.statusOf(client) !== 'approved') return null;
    return {
      delegation_id: delegation.id,
      user_id: delegation.userId,
      client_id: client.clientId,
      scopes: scopesOf(delegation.scope),
      expires_at: found.token.expiresAt,
    };
  }
}
