/**
 * `<ResourceDetailClient>` — client island inside the Resource detail
 * page. Owns:
 *   - Health probe button (Phase 4).
 *   - "Add access" dialog state (Phase 4).
 *   - Per-access-key "Rotate" button (Phase 6 wave C).
 *   - Destroy cloud resource button (Phase 6 wave C — only when the
 *     row is scope='project' AND has a non-null admin_resource_id).
 *
 * The static metadata (provider_metadata, access summary list, audit
 * timeline) is rendered server-side by the parent page; this component
 * is mounted next to it for interactions.
 */

'use client';

import { useState } from 'react';

import { AddAccessDialog } from './AddAccessDialog';
import { DestroyCloudResourceButton } from './DestroyCloudResourceButton';
import { RotateAccessButton } from './RotateAccessButton';

export interface ResourceDetailClientProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly resourceName: string;
  /** Catalog-derived list of expected access keys (from `kind.accessSchema`). */
  readonly accessKeys: ReadonlyArray<string>;
  /** Phase 6 wave C: enable destroy (project-scoped + admin-provisioned). */
  readonly destroyEnabled: boolean;
  readonly providerRef: string | null;
  readonly adminResourceId: string | null;
}

export function ResourceDetailClient(props: ResourceDetailClientProps): React.ReactElement {
  const {
    orgSlug,
    resourceId,
    resourceName,
    accessKeys,
    destroyEnabled,
    providerRef,
    adminResourceId,
  } = props;
  const [healthState, setHealthState] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState<string | null>(null);

  const runHealth = async (): Promise<void> => {
    setHealthState('requesting…');
    try {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/health`,
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      setHealthState(body.status ?? `http ${String(res.status)}`);
    } catch (e) {
      setHealthState(e instanceof Error ? e.message : 'error');
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="resource-detail-client">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="resource-health-button"
          onClick={() => void runHealth()}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        >
          Test now (health)
        </button>
        {healthState ? (
          <span data-testid="resource-health-state" className="text-xs text-neutral-700">
            {healthState}
          </span>
        ) : null}
      </div>

      {accessKeys.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium">Add or replace access</span>
          <div className="flex flex-wrap gap-2">
            {accessKeys.map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`open-add-access-${k}`}
                onClick={() => {
                  setDialogKey(k);
                }}
                className="rounded border border-neutral-300 px-2 py-1 text-xs"
              >
                + {k}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {accessKeys.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium">Rotate access</span>
          <div className="flex flex-wrap gap-2">
            {accessKeys.map((k) => (
              <RotateAccessButton
                key={`rotate-${k}`}
                orgSlug={orgSlug}
                resourceId={resourceId}
                accessKey={k}
                onRotated={() => {
                  if (typeof window !== 'undefined') window.location.reload();
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {destroyEnabled && providerRef && adminResourceId ? (
        <DestroyCloudResourceButton
          orgSlug={orgSlug}
          resourceId={resourceId}
          resourceName={resourceName}
          providerRef={providerRef}
          adminResourceId={adminResourceId}
          onDestroyed={() => {
            if (typeof window !== 'undefined') {
              window.location.href = `/orgs/${encodeURIComponent(orgSlug)}/resources`;
            }
          }}
        />
      ) : null}

      {dialogKey ? (
        <AddAccessDialog
          orgSlug={orgSlug}
          resourceId={resourceId}
          accessKey={dialogKey}
          onSubmitted={() => {
            if (typeof window !== 'undefined') window.location.reload();
          }}
          onClose={() => {
            setDialogKey(null);
          }}
        />
      ) : null}
    </div>
  );
}
