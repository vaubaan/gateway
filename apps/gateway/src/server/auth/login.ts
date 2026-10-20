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
import { LEGACY_PROVIDER_ID } from '../config/sign-in';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, toIso, type Clock } from '../store/clock';
import type { GroupRecord, UserRecord } from '../store/types';
import {
  isOperator,
  type AdministratorsService,
  type ResolvedAdministrators,
} from './administrators';
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
  administrators: ResolvedAdministrators,
  providerId: string | null = null,
): Promise<Authority> {
  const groups = await store.groups.groupsOf(user.id);
  // A designated group is a group of one sign-in provider: only a membership that
  // provider claimed counts (`isOperator`). A local group, kept by an operator in
  // Administration, never makes anyone an operator.
  return {
    groups,
    isOperator: isOperator({ id: user.id, email: user.email, providerId, groups }, administrators),
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
  providerId: string = LEGACY_PROVIDER_ID,
): Promise<void> {
  const { skipped } = await store.groups.syncIdpMemberships(userId, claimedNames, providerId);
  for (const name of skipped) {
    logger.warn(
      'group claim collides with a local group or a group of another sign-in provider; claim ignored',
      { group: name, provider: providerId },
    );
  }
}

/** What the sign-in knows besides the identity: which provider, and who administers. */
export interface LoginContext {
  readonly providerId: string;
  readonly administrators: Pick<AdministratorsService, 'consumeAtSignIn' | 'current'>;
}

export async function completeLogin(
  deps: LoginDeps,
  claims: IdentityClaims,
  context: LoginContext,
): Promise<LoginOutcome> {
  // Accounts from before the store recorded an issuer belong to the identity provider
  // the instance was using — the single provider, `idp`: its first validated sign-in
  // after the upgrade names it, for all of them, before any is looked up (migration
  // 0011). A sign-in through any other provider binds nothing.
  const bound =
    context.providerId === LEGACY_PROVIDER_ID
      ? await deps.store.users.bindUnboundTo(claims.issuer)
      : 0;
  if (bound > 0) {
    deps.logger.warn('existing accounts bound to the identity provider of this sign-in', {
      issuer: claims.issuer,
      accounts: bound,
    });
  }
  // A user is (issuer, subject): the same subject from another issuer is somebody else.
  const known = await deps.store.users.getByIdentity(claims.issuer, claims.subject);
  if (known && known.status !== 'active') {
    throw new LoginError(
      'account-deactivated',
      `user ${known.id} was deactivated on this instance (${known.removedAt ?? 'date unknown'}); ` +
        'an operator reactivates them under Administration → Users',
    );
  }
  const user = await deps.store.users.upsertFromIdp({
    issuer: claims.issuer,
    subject: claims.subject,
    email: claims.email,
    displayName: claims.displayName,
  });
  // Deactivated between the read above and the upsert: the row says so, and nothing
  // of this sign-in is applied to it (the upsert never changes a status).
  if (user.status !== 'active') {
    throw new LoginError(
      'account-deactivated',
      `user ${user.id} was deactivated on this instance while signing in`,
    );
  }
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
  await syncIdpGroups(deps.store, user.id, claims.groups, deps.logger, context.providerId);
  try {
    await membershipsChanged?.();
  } catch (err) {
    settleFailed(err);
  }
  // A pending address that names this person becomes their own designation now.
  await context.administrators.consumeAtSignIn(user, context.providerId);
  const authority = await currentAuthority(
    deps.store,
    user,
    await context.administrators.current(),
    context.providerId,
  );

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
    provider: context.providerId,
    groups: authority.groups.length,
    operator: authority.isOperator,
  });
  return { user, ...authority, bootstrapRevoked };
}
