/**
 * `<ResourceStatusBadge>` — colored pill for the Resource lifecycle status
 * (`pending|active|failed|detached`) and the live connection status
 * (`unknown|connected|broken`). Spec §11.2 ("Status badges").
 */

import type { ReactElement } from 'react';

const STATUS_CLASS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-900',
  pending: 'bg-amber-100 text-amber-900',
  failed: 'bg-red-100 text-red-900',
  detached: 'bg-neutral-200 text-neutral-700',
  unknown: 'bg-neutral-200 text-neutral-700',
  connected: 'bg-emerald-100 text-emerald-900',
  broken: 'bg-red-100 text-red-900',
};

export interface ResourceStatusBadgeProps {
  readonly label: string;
  /** Optional tooltip — typically `connection_message` from the row. */
  readonly title?: string;
  readonly kind?: 'status' | 'connection';
}

export function ResourceStatusBadge(props: ResourceStatusBadgeProps): ReactElement {
  const { label, title, kind: _kind } = props;
  const cls = STATUS_CLASS[label] ?? 'bg-neutral-200 text-neutral-700';
  return (
    <span
      data-testid={`badge-${label}`}
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
