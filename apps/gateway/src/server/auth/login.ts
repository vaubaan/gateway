/**
 * What a successful IdP sign-in does to the store (plan §3.4):
 * `users` upsert, IdP-sourced memberships replaced, bootstrap token revoked
 * on the first operator sign-in. Authority is never cached here: callers
 * recompute it with `currentAuthority()` on every check (spec §10).
 *
 * A user an operator deactivated does not sign in: the identity provider
 * still vouching for them is exactly the case deactivation exists for. The
 * refusal comes before anything is written (no row refreshed, no group
 * synced, no bootstrap revocation).
 */
import type { AdminRule } from '../config/types';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, toIso, type Clock } from '../store/clock';
import type { GroupRecord, UserRecord } from '../store/types';
import { isOperator } from './admin-rule';
import type { BootstrapService } from './bootstrap';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';

export interface Authority {
  readonly groups: readonly GroupRecord[];
  readonly isOperator: boolean;
}

export interface LoginOutcome extends Authority {
  readonly user: UserRecord;
  /** True when this sign-in revoked the bootstrap token. */
  readonly bootstrapRevoked: boolean;
}

export interface LoginDeps {
  readonly store: Store;
  readonly adminRule: AdminRule;
  readonly bootstrap: BootstrapService;
  readonly logger: Logger;
  readonly clock?: Clock;
  /**
   * Called before the sign-in replaces the user's IdP-sourced memberships;
   * the function it returns is called once they are replaced. What the
   * change did is settled between the two: a connection left without owner
   * becomes `unowned`, and the user's missions that a lost membership left
   * orphaned, or a regained one grounds again, are audited. A failure of
   * either call is logged and does not fail the sign-in: every authority
   * check reads the new memberships anyway.
   */
  readonly membershipsChanging?: (user: UserRecord) => Promise<MembershipsChanged>;
}

/** Called once the memberships are replaced (`LoginDeps.membershipsChanging`). */
export type MembershipsChanged = () => Promise<void>;

/** The user's authority right now, from the store (never from the session). */
export async function currentAuthority(
  store: Store,
  user: UserRecord,
  adminRule: AdminRule,
): Promise<Authority> {
  const groups = await store.groups.groupsOf(user.id);
  // The admin rule names an IdP group: only a membership the IdP claimed counts. A local
  // group, kept by an operator in Administration, never makes anyone an operator.
  const claimed = groups.filter((g) => g.source === 'idp').map((g) => g.name);
  return {
    groups,
    isOperator: isOperator({ email: user.email, groupNames: claimed }, adminRule),
  };
}

/**
 * Replaces the user's IdP-sourced memberships with the claim list, in one
 * store transaction: a membership change is an authorization change, applied
 * whole or not at all. Local groups (operator-kept) are never touched: a claim
 * whose name collides with a local group is skipped with a warning rather
 * than silently granting it.
 */
export async function syncIdpGroups(
  store: Store,
  userId: string,
  claimedNames: readonly string[],
  logger: Logger,
): Promise<void> {
  const { skipped } = await store.groups.syncIdpMemberships(userId, claimedNames);
  for (const name of skipped) {
    logger.warn('IdP group claim collides with a local group; claim ignored', { group: name });
  }
}

export async function completeLogin(
  deps: LoginDeps,
  claims: IdentityClaims,
): Promise<LoginOutcome> {
  const known = await deps.store.users.getBySubject(claims.subject);
  if (known && known.status !== 'active') {
    throw new LoginError(
      'account-deactivated',
      `user ${known.id} was deactivated on this instance (${known.removedAt ?? 'date unknown'}); ` +
        'an operator reactivates them under Administration → Users',
    );
  }
  const user = await deps.store.users.upsertFromIdp({
    subject: claims.subject,
    email: claims.email,
    displayName: claims.displayName,
  });
  const settleFailed = (err: unknown): void => {
    deps.logger.error('could not settle the memberships changed by a sign-in', {
      user_id: user.id,
      err,
    });
  };
  let membershipsChanged: MembershipsChanged | undefined;
  try {
    membershipsChanged = await deps.membershipsChanging?.(user);
  } catch (err) {
    settleFailed(err);
  }
  await syncIdpGroups(deps.store, user.id, claims.groups, deps.logger);
  try {
    await membershipsChanged?.();
  } catch (err) {
    settleFailed(err);
  }
  const authority = await currentAuthority(deps.store, user, deps.adminRule);

  let bootstrapRevoked = false;
  if (authority.isOperator && (await deps.bootstrap.state()).status === 'active') {
    const revoked = await deps.bootstrap.revoke();
    bootstrapRevoked = true;
    await deps.store.auditWriter.write({
      kind: 'admin',
      ts:
        revoked.status === 'revoked' ? revoked.revokedAt : toIso((deps.clock ?? systemClock).now()),
      user_id: user.id,
      act: 'config-changed',
      object: { type: 'instance-config', id: 'bootstrap' },
      before: { status: 'active' },
      after: { status: revoked.status },
      delegated_client_id: null,
    });
    deps.logger.info('bootstrap token revoked after the first operator sign-in', {
      user_id: user.id,
    });
  }
  deps.logger.info('user signed in', {
    user_id: user.id,
    groups: authority.groups.length,
    operator: authority.isOperator,
  });
  return { user, ...authority, bootstrapRevoked };
}
