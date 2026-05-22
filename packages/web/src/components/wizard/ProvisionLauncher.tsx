/**
 * `<ProvisionLauncher>` — Phase 6 wave C. Dropdown of live Admin
 * resources on the org's resources page; clicking one navigates to
 * `/orgs/:slug/resources/provision?admin=:rId`.
 */

'use client';

import { useMemo, useState } from 'react';

import type { ResourceRow } from '@/components/resources/ResourceTable';
import { Button } from '@/components/ui';

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
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="resources-page-provision-button"
        disabled
        title="Register an org-admin first to provision child resources."
        className="text-subtle"
      >
        + Provision via …
      </Button>
    );
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="resources-page-provision-button"
        onClick={() => setOpen((p) => !p)}
      >
        + Provision via …
      </Button>
      {open ? (
        <ul
          data-testid="provision-admin-dropdown"
          className="absolute right-0 z-10 mt-1 flex flex-col rounded border border-border-default bg-surface p-1 text-sm shadow"
        >
          {admins.map((a) => (
            <li key={a.id}>
              <a
                data-testid={`provision-admin-${a.id}`}
                href={`/orgs/${encodeURIComponent(orgSlug)}/resources/provision?admin=${encodeURIComponent(a.id)}`}
                className="block rounded px-2 py-1 text-xs hover:bg-sunken"
              >
                {a.name} <span className="text-subtle">({a.kind})</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
