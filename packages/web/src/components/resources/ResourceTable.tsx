/**
 * `<ResourceTable>` — client-side filtering on the Resource list page.
 *
 * The server component passes the raw rows (already RLS-filtered by the
 * Supabase server client). The user picks filters in-browser; no
 * additional network round-trip required.
 *
 * Spec §11.1 (pages) and §11.2 (status badges).
 */

'use client';

import { useMemo, useState } from 'react';

import { findKind } from '@crm/catalog';

import { ResourceStatusBadge } from './ResourceStatusBadge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui';

export interface ResourceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly provider_name: string;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly is_admin: boolean;
  readonly name: string;
  readonly variant: string | null;
  readonly status: string;
  readonly connection_status: string;
  readonly connection_checked_at: string | null;
  readonly connection_message: string | null;
}

export interface ResourceTableProps {
  readonly orgSlug: string;
  readonly resources: ReadonlyArray<ResourceRow>;
}

type KindClassFilter = 'all' | 'org' | 'project' | 'org-admin';

function kindClassOf(kindId: string): 'org' | 'project' | 'org-admin' | 'unknown' {
  const k = findKind(kindId);
  if (!k) return 'unknown';
  return k.kindClass;
}

export function ResourceTable(props: ResourceTableProps): React.ReactElement {
  const { orgSlug, resources } = props;
  const [provider, setProvider] = useState<string>('all');
  const [kindClass, setKindClass] = useState<KindClassFilter>('all');
  const [variant, setVariant] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');

  const providers = useMemo(
    () => Array.from(new Set(resources.map((r) => r.provider_name))).sort(),
    [resources],
  );
  const variants = useMemo(
    () =>
      Array.from(
        new Set(resources.map((r) => r.variant).filter((v): v is string => v !== null)),
      ).sort(),
    [resources],
  );
  const statuses = useMemo(
    () => Array.from(new Set(resources.map((r) => r.status))).sort(),
    [resources],
  );

  const filtered = useMemo(() => {
    return resources.filter((r) => {
      if (provider !== 'all' && r.provider_name !== provider) return false;
      if (kindClass !== 'all') {
        const kc = kindClassOf(r.kind);
        if (kc !== kindClass) return false;
      }
      if (variant !== 'all' && (r.variant ?? '') !== variant) return false;
      if (status !== 'all' && r.status !== status) return false;
      return true;
    });
  }, [resources, provider, kindClass, variant, status]);

  return (
    <div className="flex flex-col gap-4" data-testid="resource-table">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <FilterSelect
          testid="filter-provider"
          label="Provider"
          value={provider}
          options={['all', ...providers]}
          onChange={setProvider}
        />
        <FilterSelect
          testid="filter-kindClass"
          label="Class"
          value={kindClass}
          options={['all', 'org', 'project', 'org-admin']}
          onChange={(v) => {
            setKindClass(v as KindClassFilter);
          }}
        />
        <FilterSelect
          testid="filter-variant"
          label="Variant"
          value={variant}
          options={['all', ...variants]}
          onChange={setVariant}
        />
        <FilterSelect
          testid="filter-status"
          label="Status"
          value={status}
          options={['all', ...statuses]}
          onChange={setStatus}
        />
        <span data-testid="resource-table-count" className="ml-auto text-muted">
          {String(filtered.length)} / {String(resources.length)}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div
          data-testid="resource-table-empty"
          className="rounded-sm border border-dashed border-border-default p-6 text-center text-sm text-muted"
        >
          No resources match the current filters.
        </div>
      ) : (
        <Table density="compact">
          <THead>
            <TR>
              <TH>Provider</TH>
              <TH>Kind</TH>
              <TH>Name</TH>
              <TH>Scope</TH>
              <TH>Variant</TH>
              <TH>Status</TH>
              <TH>Connection</TH>
              <TH>Last check</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((r) => (
              <TR key={r.id} data-testid={`resource-row-${r.id}`}>
                <TD>{r.provider_name}</TD>
                <TD className="font-mono text-xs">{r.kind}</TD>
                <TD>
                  <a
                    href={`/orgs/${orgSlug}/resources/${r.id}`}
                    className="text-foreground underline"
                  >
                    {r.name}
                  </a>
                </TD>
                <TD>
                  {r.scope}
                  {r.is_admin ? ' · admin' : ''}
                </TD>
                <TD>{r.variant ?? '—'}</TD>
                <TD>
                  <ResourceStatusBadge label={r.status} kind="status" />
                </TD>
                <TD>
                  <ResourceStatusBadge
                    label={r.connection_status}
                    kind="connection"
                    title={r.connection_message ?? undefined}
                  />
                </TD>
                <TD className="text-xs text-muted">
                  {r.connection_checked_at ? new Date(r.connection_checked_at).toISOString() : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function FilterSelect(props: {
  readonly testid: string;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<string>;
  readonly onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label className="inline-flex items-center gap-1">
      <span className="text-muted">{props.label}</span>
      <select
        data-testid={props.testid}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className="rounded-sm border border-border-default bg-surface px-1 py-0.5 text-foreground"
      >
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
