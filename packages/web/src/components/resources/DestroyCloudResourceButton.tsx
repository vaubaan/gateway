/**
 * `<DestroyCloudResourceButton>` — Phase 6 wave C. Confirms a
 * type-name match (à la GitHub repo deletion), then:
 *
 *   1. Unseal the parent admin's access bundle in-memory.
 *   2. Call `admin.destroyChild(access, providerRef)` (browser-side).
 *   3. POST DELETE /destroy-cloud-resource (book-keeping).
 *
 * Spec §6.5, §7.3.
 *
 * ZK: the admin's unsealed access bytes are wiped immediately after
 * the provider call.
 */

'use client';

import { useState } from 'react';

import { findKind, type OrgResourceAdminKind } from '@crm/catalog';
import { unsealAs, type SealedBlobV1 } from '@crm/core/crypto';

import { Button, Input } from '@/components/ui';
import { identityStore } from '@/lib/crypto/identity-store';

export interface DestroyCloudResourceButtonProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly providerRef: string;
  readonly adminResourceId: string;
  readonly onDestroyed?: () => void;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'running'; status: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export function DestroyCloudResourceButton(
  props: DestroyCloudResourceButtonProps,
): React.ReactElement {
  const { orgSlug, resourceId, resourceName, providerRef, adminResourceId, onDestroyed } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });
  const [typed, setTyped] = useState('');

  const handleDestroy = async (): Promise<void> => {
    setState({ kind: 'running', status: 'loading admin…' });
    try {
      const adminRes = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          adminResourceId,
        )}`,
      );
      if (!adminRes.ok) throw new Error(`fetch admin failed (${String(adminRes.status)})`);
      const adminBody = (await adminRes.json()) as {
        resource: {
          id: string;
          kind: string;
          provider_metadata: Record<string, unknown>;
        };
      };
      const adminKind = findKind(adminBody.resource.kind);
      if (!adminKind || adminKind.kindClass !== 'org-admin') {
        throw new Error('admin kind not in catalog or wrong kindClass');
      }
      const ak = adminKind as OrgResourceAdminKind;

      setState({ kind: 'running', status: 'unsealing admin token…' });
      const id = identityStore.get();
      if (!id) throw new Error('identity_locked');

      const accessMap: Record<string, string> = {};
      const unsealed: Uint8Array[] = [];
      for (const k of Object.keys(ak.accessSchema)) {
        const r = await fetch(
          `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
            adminResourceId,
          )}/access/${encodeURIComponent(k)}`,
        );
        if (!r.ok) throw new Error(`fetch admin access ${k} failed`);
        const body = (await r.json()) as { sealed_blob: SealedBlobV1 };
        const plain = await unsealAs(body.sealed_blob, id.fingerprint, {
          publicKey: id.publicKey,
          privateKey: id.privateKey,
        });
        if (plain === null) throw new Error(`not_a_recipient_for_${k}`);
        unsealed.push(plain);
        accessMap[k] = new TextDecoder().decode(plain);
      }
      // Inject identifier keys (GITHUB_ORG, SUPABASE_ORG_ID, …)
      if (
        ak.provider === 'github' &&
        typeof adminBody.resource.provider_metadata.org === 'string'
      ) {
        accessMap.GITHUB_ORG = adminBody.resource.provider_metadata.org;
      }

      setState({ kind: 'running', status: 'destroying cloud resource…' });
      await ak.destroyChild(accessMap, providerRef);
      for (const b of unsealed) b.fill(0);

      setState({ kind: 'running', status: 'cleaning CRM bookkeeping…' });
      const del = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/destroy-cloud-resource`,
        { method: 'DELETE' },
      );
      if (!del.ok) {
        const body = (await del.json().catch(() => ({}))) as { error?: string };
        throw new Error(`destroy-cloud-resource failed: ${body.error ?? String(del.status)}`);
      }
      setState({ kind: 'done' });
      onDestroyed?.();
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown' });
    }
  };

  if (state.kind === 'idle') {
    return (
      <Button
        type="button"
        data-testid="destroy-cloud-button"
        onClick={() => setState({ kind: 'confirm' })}
        variant="secondary"
        size="sm"
        className="border-danger-border text-danger-foreground"
      >
        Destroy cloud resource
      </Button>
    );
  }

  if (state.kind === 'confirm') {
    const canConfirm = typed === resourceName;
    return (
      <div
        data-testid="destroy-cloud-confirm"
        className="flex flex-col gap-2 rounded-sm border border-danger-border p-3"
      >
        <span className="text-xs font-medium text-danger-foreground">
          Destroy cloud resource — type the resource name to confirm
        </span>
        <Input
          data-testid="destroy-cloud-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={resourceName}
          className="text-xs"
        />
        <div className="flex gap-2">
          <Button
            type="button"
            data-testid="destroy-cloud-cancel"
            onClick={() => {
              setTyped('');
              setState({ kind: 'idle' });
            }}
            variant="secondary"
            size="sm"
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="destroy-cloud-go"
            disabled={!canConfirm}
            onClick={() => void handleDestroy()}
            variant="danger"
            size="sm"
          >
            Destroy
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'running') {
    return (
      <span data-testid="destroy-cloud-running" className="text-xs text-muted">
        {state.status}
      </span>
    );
  }

  if (state.kind === 'done') {
    return (
      <span data-testid="destroy-cloud-done" className="text-xs text-success-foreground">
        Cloud resource destroyed.
      </span>
    );
  }

  return (
    <span data-testid="destroy-cloud-error" className="text-xs text-danger-foreground">
      {state.message}
    </span>
  );
}
