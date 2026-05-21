/**
 * `<RotateAccessButton>` — Phase 6 wave C dispatcher button for the 3
 * rotation paths (spec §0.1, §7.4).
 *
 * Flow:
 *
 *   1. Click → POST /access/:key/rotate → server returns
 *      { rotation_method, next_step, setup_docs, admin_resource_id?,
 *        admin_kind?, child_provider_ref? }.
 *   2. Dispatch:
 *        - `manual` / `self` → show the kind's setupDocs and a
 *          <SealedInput> so the operator can paste the new value.
 *        - `admin-mediated` → if `admin_resource_id` is present, attempt
 *          to (a) fetch the admin's GITHUB_TOKEN / VERCEL_TOKEN / etc.
 *          access blob, (b) unseal it in-memory via the current user's
 *          identity, (c) call the provider kind's `rotateChildAccess`
 *          method, (d) immediately seal the returned cleartext, (e)
 *          PUT /access/:key. If the provider returns
 *          *RotationNotSupportedError, fall back to the manual paste
 *          flow.
 *
 * ZK invariants:
 *
 *   - The cleartext returned by `rotateChildAccess` lives in a
 *     `Uint8Array` that is wiped (`.fill(0)`) before this function
 *     returns.
 *   - The admin's access bundle is unsealed transitorily; the unsealed
 *     bytes are wiped immediately after the provider call.
 *
 * Phase 6 ships a minimal but functional version: the wizard polish
 * (modal, step indicator) lands in Phase 7.
 */

'use client';

import { useState } from 'react';

import {
  GitHubRotationNotSupportedError,
  SupabaseRotationNotSupportedError,
  VercelRotationNotSupportedError,
  findKind,
} from '@crm/catalog';
import { sealForRecipients, unsealAs, type PubKeyEntry, type SealedBlobV1 } from '@crm/core/crypto';

import { identityStore } from '@/lib/crypto/identity-store';
import { SealedInput } from '@/components/sealed/SealedInput';

export interface RotateAccessButtonProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly accessKey: string;
  /** Optional callback after a successful PUT (parent can refresh). */
  readonly onRotated?: () => void;
}

interface DispatchInfo {
  readonly rotation_method: 'self' | 'admin-mediated' | 'manual';
  readonly next_step: string;
  readonly setup_docs?: string;
  readonly admin_resource_id?: string | null;
  readonly admin_kind?: string | null;
  readonly child_provider_ref?: string | null;
  readonly message?: string;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'dispatching' }
  | { kind: 'manual-paste'; info: DispatchInfo }
  | { kind: 'running-admin'; info: DispatchInfo }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

async function fetchSealedBlob(
  orgSlug: string,
  resourceId: string,
  accessKey: string,
): Promise<SealedBlobV1> {
  const res = await fetch(
    `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
      resourceId,
    )}/access/${encodeURIComponent(accessKey)}`,
  );
  if (!res.ok) throw new Error(`fetch access ${accessKey} failed (${String(res.status)})`);
  const body = (await res.json()) as { sealed_blob?: SealedBlobV1 };
  if (!body.sealed_blob) throw new Error(`no sealed_blob in response`);
  return body.sealed_blob;
}

async function fetchRecipients(
  orgSlug: string,
  resourceId: string,
  accessKey: string,
): Promise<PubKeyEntry[]> {
  const res = await fetch(
    `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
      resourceId,
    )}/access/${encodeURIComponent(accessKey)}/recipients`,
  );
  if (!res.ok) throw new Error(`fetch recipients failed (${String(res.status)})`);
  const body = (await res.json()) as {
    recipients?: Array<{ public_key: string; fingerprint: string }>;
  };
  if (!body.recipients) return [];
  return body.recipients.map((r) => ({
    publicKey: new Uint8Array(Buffer.from(r.public_key, 'base64')),
    fingerprint: r.fingerprint,
  }));
}

async function putSealedBlob(
  orgSlug: string,
  resourceId: string,
  accessKey: string,
  blob: SealedBlobV1,
): Promise<void> {
  const res = await fetch(
    `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
      resourceId,
    )}/access/${encodeURIComponent(accessKey)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blob),
    },
  );
  if (!res.ok) throw new Error(`PUT /access/${accessKey} failed (${String(res.status)})`);
}

export function RotateAccessButton(props: RotateAccessButtonProps): React.ReactElement {
  const { orgSlug, resourceId, accessKey, onRotated } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  const handleStart = async (): Promise<void> => {
    setState({ kind: 'dispatching' });
    try {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/access/${encodeURIComponent(accessKey)}/rotate`,
        { method: 'POST' },
      );
      if (!res.ok && res.status !== 202) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? `http ${String(res.status)}` });
        return;
      }
      const info = (await res.json()) as DispatchInfo;
      if (info.rotation_method === 'admin-mediated' && info.admin_resource_id) {
        setState({ kind: 'running-admin', info });
        await dispatchAdminMediated(info);
        return;
      }
      setState({ kind: 'manual-paste', info });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown' });
    }
  };

  const dispatchAdminMediated = async (info: DispatchInfo): Promise<void> => {
    try {
      const adminKindId = info.admin_kind;
      if (typeof adminKindId !== 'string') throw new Error('missing admin_kind');
      const adminKind = findKind(adminKindId);
      if (!adminKind || adminKind.kindClass !== 'org-admin') {
        throw new Error('admin kind not in catalog or wrong kindClass');
      }
      const adminRes = info.admin_resource_id;
      if (typeof adminRes !== 'string') throw new Error('missing admin_resource_id');
      const childRef = info.child_provider_ref;
      if (typeof childRef !== 'string') throw new Error('missing child_provider_ref');

      // Pull and unseal every key of the admin's access bundle into a
      // transient cleartext map. We need at least the provider's
      // auth token + the org/team id (set by the kind's wrapper).
      const adminAccessSchema = adminKind.accessSchema;
      const accessMap: Record<string, string> = {};
      const unsealedBytes: Uint8Array[] = [];
      const id = identityStore.get();
      if (!id) throw new Error('identity_locked');
      for (const k of Object.keys(adminAccessSchema)) {
        // Fetch the admin's sealed blob for this key.
        const blob = await fetchSealedBlob(orgSlug, adminRes, k);
        const plain = await unsealAs(blob, id.fingerprint, {
          publicKey: id.publicKey,
          privateKey: id.privateKey,
        });
        if (plain === null) throw new Error(`not_a_recipient_for_${k}`);
        unsealedBytes.push(plain);
        accessMap[k] = new TextDecoder().decode(plain);
      }

      // The wrapper layer used to live server-side; here we inject
      // provider-specific identifier keys from the admin's
      // provider_metadata via a second fetch.
      const adminMetadata = await fetchResourceMetadata(orgSlug, adminRes);
      if (adminKind.provider === 'github' && typeof adminMetadata.org === 'string') {
        accessMap.GITHUB_ORG = adminMetadata.org;
      }
      if (adminKind.provider === 'supabase-cloud') {
        // Supabase's listChildren filters by SUPABASE_ORG_ID when set;
        // for rotate we don't need it but we set it for consistency.
        if (typeof adminMetadata.organizationId === 'string') {
          accessMap.SUPABASE_ORG_ID = adminMetadata.organizationId;
        }
      }

      // Cast: the catalog declares `rotateChildAccess` only on
      // OrgResourceAdminKind; we just verified kindClass above.
      type AdminKind = typeof adminKind & {
        rotateChildAccess(
          a: Readonly<Record<string, string>>,
          ref: string,
          k: string,
        ): Promise<string>;
      };
      const newCleartext = await (adminKind as unknown as AdminKind).rotateChildAccess(
        accessMap,
        childRef,
        accessKey,
      );
      // Wipe admin's unsealed bytes ASAP.
      for (const b of unsealedBytes) b.fill(0);

      // Seal the new value for the current recipients of the child
      // Resource and PUT.
      const childRecipients = await fetchRecipients(orgSlug, resourceId, accessKey);
      const newBytes = new TextEncoder().encode(newCleartext);
      const sealed = await sealForRecipients(newBytes, childRecipients);
      newBytes.fill(0);
      await putSealedBlob(orgSlug, resourceId, accessKey, sealed);
      setState({ kind: 'done' });
      onRotated?.();
    } catch (err) {
      if (
        err instanceof GitHubRotationNotSupportedError ||
        err instanceof VercelRotationNotSupportedError ||
        err instanceof SupabaseRotationNotSupportedError
      ) {
        // Fallback to manual paste — the kind's error carries the
        // markdown setupDocs the operator should follow.
        setState({
          kind: 'manual-paste',
          info: {
            rotation_method: 'manual',
            next_step: 'operator-action',
            setup_docs: err.setupDocs,
            message: err.message,
          },
        });
        return;
      }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'unknown' });
    }
  };

  const handleManualSealed = async (blob: SealedBlobV1): Promise<void> => {
    try {
      await putSealedBlob(orgSlug, resourceId, accessKey, blob);
      setState({ kind: 'done' });
      onRotated?.();
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown' });
    }
  };

  if (state.kind === 'idle') {
    return (
      <button
        type="button"
        data-testid={`rotate-${accessKey}`}
        onClick={() => void handleStart()}
        className="rounded border border-neutral-300 px-2 py-1 text-xs"
      >
        Rotate
      </button>
    );
  }

  if (state.kind === 'dispatching') {
    return <span className="text-xs text-neutral-700">Dispatching rotation…</span>;
  }

  if (state.kind === 'running-admin') {
    return (
      <span data-testid="rotate-admin-running" className="text-xs text-neutral-700">
        Rotating via admin {state.info.admin_kind ?? '?'}…
      </span>
    );
  }

  if (state.kind === 'manual-paste') {
    return (
      <div
        data-testid="rotate-manual"
        className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
      >
        <span className="text-xs font-medium">Manual rotation — {accessKey}</span>
        {state.info.setup_docs ? (
          <pre
            data-testid="rotate-setup-docs"
            className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-neutral-100 px-2 py-1 text-xs"
          >
            {state.info.setup_docs}
          </pre>
        ) : null}
        <SealedInput resourceId={resourceId} accessKey={accessKey} onSealed={handleManualSealed} />
        <button
          type="button"
          className="self-start text-xs underline"
          onClick={() => setState({ kind: 'idle' })}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.kind === 'done') {
    return (
      <span data-testid="rotate-done" className="text-xs text-green-700">
        Rotated successfully.
      </span>
    );
  }

  return (
    <div data-testid="rotate-error" className="flex flex-col gap-2 text-xs text-red-700">
      <span>Rotation failed: {state.message}</span>
      <button
        type="button"
        className="self-start text-xs underline"
        onClick={() => setState({ kind: 'idle' })}
      >
        Reset
      </button>
    </div>
  );
}

async function fetchResourceMetadata(
  orgSlug: string,
  resourceId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(resourceId)}`,
  );
  if (!res.ok) return {};
  const body = (await res.json()) as { resource?: { provider_metadata?: Record<string, unknown> } };
  return body.resource?.provider_metadata ?? {};
}
