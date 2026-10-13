/**
 * The count next to "Requests" in the application bar: open requests awaiting
 * the signed-in user as creator (spec §4.2 "Request inbox"). Nothing when
 * there is none, and nothing for the bootstrap operator, who creates no
 * mission. Server component.
 */
import { Badge } from '@/components/ui';
import type { Principal } from '@/server/auth';
import { getRoot } from '@/server/compose';

export async function OpenRequestCount({ principal }: { principal: Principal }) {
  if (principal.kind !== 'user') return null;
  const root = await getRoot();
  const count = await root.requests.service.openCount(principal.user);
  if (count === 0) return null;
  return (
    <>
      {' '}
      <Badge tone="warning">
        <span
          data-testid="open-request-count"
          aria-label={`${count} open ${count === 1 ? 'request' : 'requests'}`}
        >
          {count}
        </span>
      </Badge>
    </>
  );
}
