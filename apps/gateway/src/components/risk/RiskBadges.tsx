/**
 * The two badges every risk line shows: its catalog severity and its gate.
 * One statement of each, so a new severity level or gate is styled in one place.
 */
import type { Gate } from '@vaubaan/shared';

import { Badge, type BadgeTone } from '@/components/ui';
import type { SeverityLevel } from '@/server/missions/model';

/** Keyed by level: a new level fails to compile until it has its tone. */
const SEVERITY_TONE: Readonly<Record<SeverityLevel, BadgeTone>> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export function SeverityBadge({ level }: { level: SeverityLevel }) {
  return <Badge tone={SEVERITY_TONE[level]}>{level}</Badge>;
}

/** `approval` stands out; `auto` is the plain word. */
export function GateBadge({ gate }: { gate: Gate }) {
  return gate === 'approval' ? <Badge tone="warning">approval</Badge> : <>auto</>;
}
