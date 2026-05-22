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

import { unsealAs, decodeUtf8, type SealedBlobV1 } from '@crm/core/crypto';

import { AddAccessDialog } from './AddAccessDialog';
import { DestroyCloudResourceButton } from './DestroyCloudResourceButton';
import { RotateAccessButton } from './RotateAccessButton';
import { Button } from '@/components/ui';
import { identityStore } from '@/lib/crypto/identity-store';
import { runHealthProbe } from '@/lib/health/probe';

export interface ResourceDetailClientProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly resourceName: string;
  /** Catalog kind id (e.g. 'github-org'). Drives the browser probe. */
  readonly kindId: string;
  /** Catalog-derived list of expected access keys (from `kind.accessSchema`). */
  readonly accessKeys: ReadonlyArray<string>;
  /** Phase 6 wave C: enable destroy (project-scoped + admin-provisioned). */
  readonly destroyEnabled: boolean;
  readonly providerRef: string | null;
  readonly providerMetadata: Record<string, unknown>;
  readonly adminResourceId: string | null;
}

export function ResourceDetailClient(props: ResourceDetailClientProps): React.ReactElement {
  const {
    orgSlug,
    resourceId,
    resourceName,
    kindId,
    accessKeys,
    destroyEnabled,
    providerRef,
    providerMetadata,
    adminResourceId,
  } = props;
  const [healthState, setHealthState] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState<string | null>(null);

  const runHealth = async (): Promise<void> => {
    setHealthState('checking…');
    const identity = identityStore.get();
    if (!identity) {
      setHealthState('identity locked — unlock your crypto identity first');
      return;
    }

    // Unseal every access key the catalog declares for this kind.
    // Health probes typically need exactly one (GITHUB_TOKEN /
    // VERCEL_TOKEN / SUPABASE_ACCESS_TOKEN) but we hand the full map
    // to the probe so future kinds can compose multiple creds.
    const accessRecord: Record<string, string> = {};
    for (const key of accessKeys) {
      try {
        const res = await fetch(
          `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
            resourceId,
          )}/access/${encodeURIComponent(key)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) continue;
        const body = (await res.json()) as { sealed_blob?: SealedBlobV1 };
        if (!body.sealed_blob) continue;
        const plain = await unsealAs(body.sealed_blob, identity.fingerprint, {
          publicKey: identity.publicKey,
          privateKey: identity.privateKey,
        });
        if (plain) accessRecord[key] = decodeUtf8(plain);
      } catch {
        // skip — leave key absent, probe will report 'unknown'.
      }
    }

    const result = await runHealthProbe({
      kindId,
      providerRef,
      metadata: providerMetadata,
      access: accessRecord,
    });

    // Persist the result server-side (audit + connection_status).
    try {
      await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/health`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: result.status, message: result.message }),
        },
      );
    } catch {
      // best-effort persistence — show the probe result to the user anyway.
    }

    setHealthState(`${result.status}: ${result.message}`);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="resource-detail-client">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          data-testid="resource-health-button"
          onClick={() => void runHealth()}
          variant="secondary"
          size="sm"
        >
          Test now (health)
        </Button>
        {healthState ? (
          <span data-testid="resource-health-state" className="text-xs text-muted">
            {healthState}
          </span>
        ) : null}
      </div>

      {accessKeys.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">Add or replace access</span>
          <div className="flex flex-wrap gap-2">
            {accessKeys.map((k) => (
              <Button
                key={k}
                type="button"
                data-testid={`open-add-access-${k}`}
                onClick={() => {
                  setDialogKey(k);
                }}
                variant="secondary"
                size="sm"
              >
                + {k}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {accessKeys.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">Rotate access</span>
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
