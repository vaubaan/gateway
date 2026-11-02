/**
 * The community validation status of a service's plugin (spec §9 "the
 * instance's interface shows this status on each connection").
 *
 * Renders nothing when there is no status to show: telemetry off, no
 * collector, no report yet for the plugin version this gateway runs, or a
 * collector that did not answer. A fact, not a state: a quiet tag whose words
 * say it, with the figures behind it as its title.
 */
import { Tag } from '@/components/ui';
import type { ValidationStatus } from '@/server/telemetry';

const PERCENT = 100;

export function ValidationBadge({ status }: { status: ValidationStatus | null }) {
  if (!status) return null;
  const detail =
    status.successRate === null
      ? `${status.reports} community reports, all refused for a rejected credential: no rate`
      : `${Math.round(status.successRate * PERCENT)}% of ${status.reports} community reports succeeded, rejected credentials left out`;
  return (
    <span title={detail} data-testid="validation-status">
      <Tag dashed={!status.validated}>
        {status.validated ? 'validated by the community' : 'not yet validated by the community'}
      </Tag>
    </span>
  );
}
