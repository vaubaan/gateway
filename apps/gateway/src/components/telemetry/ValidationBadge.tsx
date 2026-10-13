/**
 * The community validation status of a connection's plugin (spec §9 "the
 * instance's interface shows this status on each connection").
 *
 * Renders nothing when there is no status to show: telemetry off, no
 * collector, no report yet for the plugin version this instance runs, or a
 * collector that did not answer.
 */
import { Badge } from '@/components/ui';
import type { ValidationStatus } from '@/server/telemetry';

const PERCENT = 100;

export function ValidationBadge({ status }: { status: ValidationStatus | null }) {
  if (!status) return null;
  const detail = `${Math.round(status.successRate * PERCENT)}% of ${status.reports} community reports succeeded`;
  return status.validated ? (
    <Badge tone="success">
      <span title={detail}>validated by the community</span>
    </Badge>
  ) : (
    <Badge>
      <span title={detail}>not yet validated by the community</span>
    </Badge>
  );
}
