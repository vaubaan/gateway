/**
 * The signed-in user behind a Missions page, or `null`. The `(app)` layout
 * redirects a visitor with no session to the sign-in; a page that gets `null`
 * is in front of the bootstrap operator and renders `NeedsUser`.
 */
import { currentPrincipal } from '@/lib/auth/session';
import type { GatewayRoot } from '@/server/compose';
import type { UserRecord } from '@/server/store/types';

export async function currentUser(): Promise<{ root: GatewayRoot; user: UserRecord } | null> {
  const { root, principal } = await currentPrincipal();
  if (principal?.kind !== 'user') return null;
  return { root, user: principal.user };
}
