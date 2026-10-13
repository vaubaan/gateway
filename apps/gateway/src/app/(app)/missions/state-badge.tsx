import { Badge, type BadgeTone } from '@/components/ui';
import type { MissionState } from '@/server/budget';

const TONE: Record<MissionState['kind'], BadgeTone> = {
  active: 'success',
  expired: 'warning',
  orphaned: 'danger',
  revoked: 'neutral',
};

/** Mission state (spec §2.3); `exhausted` is per risk, shown as a count on an active mission. */
export function StateBadge({ state }: { state: MissionState }) {
  if (state.kind === 'active' && state.exhausted.length > 0) {
    return (
      <Badge tone="warning">
        active · {state.exhausted.length} {state.exhausted.length === 1 ? 'risk' : 'risks'}{' '}
        exhausted
      </Badge>
    );
  }
  return <Badge tone={TONE[state.kind]}>{state.kind}</Badge>;
}
