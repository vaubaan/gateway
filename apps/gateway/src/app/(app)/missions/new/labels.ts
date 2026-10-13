import type { Gate } from '@vaubaan/shared';

/** How the two gates read in the interface (spec §0 "Gate"). */
export const GATE_LABELS: Record<Gate, string> = {
  auto: 'Auto',
  approval: 'Approval',
};
