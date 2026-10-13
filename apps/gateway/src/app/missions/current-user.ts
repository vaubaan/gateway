/**
 * The signed-in user behind a Missions page, or `null`. The layout renders
 * the sign-in redirect and the bootstrap notice; a page that gets `null`
 * renders nothing (layouts and pages render independently, so each page asks
 * for itself).
 */
import { currentPrincipal } from '@/lib/auth/session';
import type { GatewayRoot } from '@/server/compose';
import type { UserRecord } from '@/server/store/types';

export async function currentUser(): Promise<{ root: GatewayRoot; user: UserRecord } | null> {
  const { root, principal } = await currentPrincipal();
  if (principal?.kind !== 'user') return null;
  return { root, user: principal.user };
}
