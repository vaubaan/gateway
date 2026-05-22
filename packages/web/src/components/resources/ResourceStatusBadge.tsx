/**
 * `<ResourceStatusBadge>` — colored pill for the Resource lifecycle status
 * (`pending|active|failed|detached`) and the live connection status
 * (`unknown|connected|broken`). Spec §11.2 ("Status badges").
 */

import type { ReactElement } from 'react';

import { Badge, type BadgeVariant } from '@/components/ui';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  pending: 'neutral',
  failed: 'danger',
  detached: 'warning',
  unknown: 'neutral',
  connected: 'success',
  broken: 'danger',
};

export interface ResourceStatusBadgeProps {
  readonly label: string;
  /** Optional tooltip — typically `connection_message` from the row. */
  readonly title?: string;
  readonly kind?: 'status' | 'connection';
}

export function ResourceStatusBadge(props: ResourceStatusBadgeProps): ReactElement {
  const { label, title, kind: _kind } = props;
  const variant = STATUS_VARIANT[label] ?? 'neutral';
  return (
    <Badge data-testid={`badge-${label}`} title={title} variant={variant} size="sm" shape="square">
      {label}
    </Badge>
  );
}
