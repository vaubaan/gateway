/**
 * What a successful IdP sign-in does to the store (plan §3.4):
 * `users` upsert, IdP-sourced memberships replaced, bootstrap token revoked
 * on the first operator sign-in. Authority is never cached here: callers
 * recompute it with `currentAuthority()` on every check (spec §10).
 */
import type { AdminRule } from '../config/types';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { GroupRecord, UserRecord } from '../store/types';
import { isOperator } from './admin-rule';
import type { BootstrapService } from './bootstrap';
import type { IdentityClaims } from './claims';

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
}

/** The user's authority right now, from the store (never from the session). */
export async function currentAuthority(
  store: Store,
  user: UserRecord,
  adminRule: AdminRule,
): Promise<Authority> {
  const groups = await store.groups.groupsOf(user.id);
  return {
    groups,
    isOperator: isOperator({ email: user.email, groupNames: groups.map((g) => g.name) }, adminRule),
  };
}

/**
 * Replaces the user's IdP-sourced memberships with the claim list. Local groups
 * (operator-kept) are never touched: a claim whose name collides with a local
 * group is skipped with a warning rather than silently granting it.
 */
export async function syncIdpGroups(
  store: Store,
  userId: string,
  claimedNames: readonly string[],
  logger: Logger,
): Promise<void> {
  const current = await store.groups.groupsOf(userId);
  const keep = new Set<string>();
  for (const name of claimedNames) {
    const group = await store.groups.getOrCreate(name, 'idp');
    if (group.source !== 'idp') {
      logger.warn('IdP group claim collides with a local group; claim ignored', { group: name });
      continue;
    }
    await store.groups.addMember(group.id, userId);
    keep.add(group.id);
  }
  for (const group of current) {
    if (group.source === 'idp' && !keep.has(group.id)) {
      await store.groups.removeMember(group.id, userId);
    }
  }
}

export async function completeLogin(
  deps: LoginDeps,
  claims: IdentityClaims,
): Promise<LoginOutcome> {
  const user = await deps.store.users.upsertFromIdp({
    subject: claims.subject,
    email: claims.email,
    displayName: claims.displayName,
  });
  await syncIdpGroups(deps.store, user.id, claims.groups, deps.logger);
  const authority = await currentAuthority(deps.store, user, deps.adminRule);

  let bootstrapRevoked = false;
  if (authority.isOperator && (await deps.bootstrap.state()).status === 'active') {
    const revoked = await deps.bootstrap.revoke();
    bootstrapRevoked = true;
    await deps.store.auditWriter.write({
      kind: 'admin',
      ts: revoked.status === 'revoked' ? revoked.revokedAt : new Date().toISOString(),
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
