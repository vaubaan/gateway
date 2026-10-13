/**
 * Naming a principal from what a human types or reads (spec §0 "Principal").
 *
 * A user is designated by their email, as displayed everywhere; the instance
 * only knows the users who signed in at least once (it stores no directory).
 * An email that matches no active user, or more than one (two IdP subjects
 * that carry the same address), designates nobody: a share or an ownership is
 * never given on a guess.
 */
import type { GroupsRepo } from '../store/repositories/groups';
import type { UsersRepo } from '../store/repositories/users';
import type { Principal, UserRecord } from '../store/types';

export type UserLookup =
  | { readonly found: true; readonly user: UserRecord }
  | { readonly found: false; readonly reason: 'unknown' | 'ambiguous' };

export async function findActiveUserByEmail(
  users: Pick<UsersRepo, 'findByEmail'>,
  raw: string,
): Promise<UserLookup> {
  const email = raw.trim();
  if (email === '') return { found: false, reason: 'unknown' };
  const candidates = new Map<string, UserRecord>();
  for (const spelling of new Set([email, email.toLowerCase()])) {
    for (const user of await users.findByEmail(spelling)) {
      if (user.status === 'active') candidates.set(user.id, user);
    }
  }
  const [first, ...others] = [...candidates.values()];
  if (!first) return { found: false, reason: 'unknown' };
  if (others.length > 0) return { found: false, reason: 'ambiguous' };
  return { found: true, user: first };
}

/** What a human reads for a principal: the user's email, or `group <name>`. */
export async function principalLabel(
  store: { users: Pick<UsersRepo, 'getById'>; groups: Pick<GroupsRepo, 'getById'> },
  principal: Principal,
): Promise<string> {
  if (principal.kind === 'user') {
    return (await store.users.getById(principal.id))?.email ?? 'unknown user';
  }
  const group = await store.groups.getById(principal.id);
  return group ? `group ${group.name}` : 'unknown group';
}
