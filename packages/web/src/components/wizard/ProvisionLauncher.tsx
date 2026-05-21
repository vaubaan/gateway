/**
 * `<ProvisionLauncher>` — Phase 6 wave C. Dropdown of live Admin
 * resources on the org's resources page; clicking one navigates to
 * `/orgs/:slug/resources/provision?admin=:rId`.
 */

'use client';

import { useMemo, useState } from 'react';

import type { ResourceRow } from '@/components/resources/ResourceTable';

export interface ProvisionLauncherProps {
  readonly orgSlug: string;
  readonly resources: ReadonlyArray<ResourceRow>;
}

export function ProvisionLauncher(props: ProvisionLauncherProps): React.ReactElement {
  const { orgSlug, resources } = props;
  const [open, setOpen] = useState(false);

  const admins = useMemo(
    () => resources.filter((r) => r.is_admin && r.scope === 'org'),
    [resources],
  );

  if (admins.length === 0) {
    return (
      <button
        type="button"
        data-testid="resources-page-provision-button"
        disabled
        title="Register an org-admin first to provision child resources."
        className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-500"
      >
        + Provision via …
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="resources-page-provision-button"
        onClick={() => setOpen((p) => !p)}
        className="rounded border border-neutral-300 px-3 py-1 text-sm"
      >
        + Provision via …
      </button>
      {open ? (
        <ul
          data-testid="provision-admin-dropdown"
          className="absolute right-0 z-10 mt-1 flex flex-col rounded border border-neutral-300 bg-white p-1 text-sm shadow"
        >
          {admins.map((a) => (
            <li key={a.id}>
              <a
                data-testid={`provision-admin-${a.id}`}
                href={`/orgs/${encodeURIComponent(orgSlug)}/resources/provision?admin=${encodeURIComponent(a.id)}`}
                className="block rounded px-2 py-1 text-xs hover:bg-neutral-100"
              >
                {a.name} <span className="text-neutral-500">({a.kind})</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
