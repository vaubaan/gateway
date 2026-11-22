/**
 * The count at the end of "Waiting for you" in the side navigation: what
 * awaits the signed-in person as the creator of a mission (spec §4.2 "Request
 * inbox") — an approval, a limit that was reached. Nothing when there is
 * none, and nothing for the bootstrap operator, who creates no mission.
 * Server component.
 */
import type { Principal } from '@/server/auth';
import { getRoot } from '@/server/compose';

import styles from './shell.styles';

export async function OpenRequestCount({ principal }: { principal: Principal }) {
  if (principal.kind !== 'user') return null;
  const root = await getRoot();
  const count = await root.requests.service.openCount(principal.user);
  if (count === 0) return null;
  return (
    <span
      className={styles.navCount}
      data-testid="open-request-count"
      aria-label={`${count} waiting for you`}
    >
      {count}
    </span>
  );
}
