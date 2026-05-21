/**
 * `<SecretManagerList>` — server-side render of the SMs of an org.
 *
 * Spec §11.1 / §6.2. Read-only listing; the action buttons
 * (set-default, delete) are handled by a separate client component
 * `<SetDefaultButton>` rendered per row.
 */

import type { ReactElement } from 'react';

import { SetDefaultButton } from './SetDefaultButton';

export interface SecretManagerRowProps {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly config: Record<string, unknown>;
  readonly created_at: string;
}

export interface SecretManagerListProps {
  readonly orgSlug: string;
  readonly items: ReadonlyArray<SecretManagerRowProps>;
}

function fmtConfigSummary(cfg: Record<string, unknown>): string {
  const ws = cfg.workspace_id;
  const ep = cfg.endpoint;
  const env = cfg.environment;
  const parts: string[] = [];
  if (typeof ep === 'string') parts.push(ep);
  if (typeof ws === 'string') parts.push(`ws=${ws}`);
  if (typeof env === 'string') parts.push(`env=${env}`);
  return parts.join(' · ');
}

export function SecretManagerList(props: SecretManagerListProps): ReactElement {
  const { items, orgSlug } = props;
  if (items.length === 0) {
    return (
      <p
        data-testid="secret-managers-empty"
        className="rounded border border-dashed border-neutral-300 p-4 text-sm text-neutral-600"
      >
        No SecretManagers yet. Click <strong>+ Connect Infisical Workspace</strong> to add one.
      </p>
    );
  }
  return (
    <table data-testid="secret-managers-table" className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b text-left text-xs uppercase text-neutral-600">
          <th className="py-2">Name</th>
          <th className="py-2">Kind</th>
          <th className="py-2">Config</th>
          <th className="py-2">Default</th>
          <th className="py-2"></th>
        </tr>
      </thead>
      <tbody>
        {items.map((sm) => (
          <tr key={sm.id} data-testid={`secret-managers-row-${sm.id}`} className="border-b">
            <td className="py-2 font-mono">{sm.name}</td>
            <td className="py-2">{sm.kind}</td>
            <td className="py-2 font-mono text-xs text-neutral-600">
              {fmtConfigSummary(sm.config)}
            </td>
            <td className="py-2">
              {sm.is_default ? (
                <span
                  data-testid={`secret-managers-default-badge-${sm.id}`}
                  className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900"
                >
                  default
                </span>
              ) : (
                <SetDefaultButton orgSlug={orgSlug} smId={sm.id} />
              )}
            </td>
            <td className="py-2 text-right text-xs text-neutral-500">
              {new Date(sm.created_at).toISOString().slice(0, 10)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
