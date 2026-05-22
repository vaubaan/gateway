/**
 * `<AddAccessDialog>` — modal-ish container around `<SealedInput>` to
 * add or replace a sealed access key on a Resource (spec §6.4 PUT).
 *
 * The dialog is intentionally lightweight (no portal). On a successful
 * PUT, it calls `onSubmitted()` so the parent can refresh.
 */

'use client';

import { useState } from 'react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { SealedInput } from '@/components/sealed/SealedInput';

export interface AddAccessDialogProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly accessKey: string;
  readonly onSubmitted?: () => void;
  readonly onClose: () => void;
}

export function AddAccessDialog(props: AddAccessDialogProps): React.ReactElement {
  const { orgSlug, resourceId, accessKey, onSubmitted, onClose } = props;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSealed = async (blob: SealedBlobV1): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/access/${encodeURIComponent(accessKey)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sealed_blob: blob }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      onSubmitted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="add-access-dialog"
      className="flex flex-col gap-3 rounded-md border border-border-default bg-surface p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Add / replace sealed access — {accessKey}
        </h3>
        <button
          type="button"
          data-testid="add-access-dialog-close"
          onClick={onClose}
          className="text-xs text-foreground underline"
        >
          Close
        </button>
      </div>
      <SealedInput
        resourceId={resourceId}
        accessKey={accessKey}
        onSealed={handleSealed}
        onError={setError}
      />
      {busy ? <span className="text-xs text-muted">Saving…</span> : null}
      {error ? (
        <span data-testid="add-access-dialog-error" className="text-xs text-danger-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}
