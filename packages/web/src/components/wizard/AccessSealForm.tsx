/**
 * Wizard step 3 — for each access key in the kind's `accessSchema`,
 * render a `<SealedInput>` and post the result to `/access/:key`.
 * Spec §7.1 steps 4-5.
 */

'use client';

import { useCallback, useState } from 'react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { SealedInput } from '@/components/sealed/SealedInput';
import type { SerializedKind } from '@/lib/catalog/serialize';

export interface AccessSealFormProps {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly kind: SerializedKind;
  readonly onDone: () => void;
  readonly onBack: () => void;
}

type KeyStatus = 'pending' | 'sealing' | 'sealed' | 'error';

export function AccessSealForm(props: AccessSealFormProps): React.ReactElement {
  const { orgSlug, resourceId, kind, onDone, onBack } = props;
  const accessKeys = Object.keys(kind.accessSchema).sort((a, b) => a.localeCompare(b));
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>(() => {
    const s: Record<string, KeyStatus> = {};
    for (const k of accessKeys) s[k] = 'pending';
    return s;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSealed = useCallback(
    async (key: string, blob: SealedBlobV1): Promise<void> => {
      setStatuses((p) => ({ ...p, [key]: 'sealing' }));
      try {
        const res = await fetch(
          `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
            resourceId,
          )}/access/${encodeURIComponent(key)}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sealed_blob: blob }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          setStatuses((p) => ({ ...p, [key]: 'error' }));
          setErrors((p) => ({
            ...p,
            [key]: body.message ?? body.error ?? `HTTP ${String(res.status)}`,
          }));
          return;
        }
        setStatuses((p) => ({ ...p, [key]: 'sealed' }));
        setErrors((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      } catch (e) {
        setStatuses((p) => ({ ...p, [key]: 'error' }));
        setErrors((p) => ({ ...p, [key]: e instanceof Error ? e.message : 'network_error' }));
      }
    },
    [orgSlug, resourceId],
  );

  const allSealed = accessKeys.every((k) => statuses[k] === 'sealed');

  return (
    <div className="flex flex-col gap-3" data-testid="wizard-access-seal">
      <h2 className="text-sm font-semibold">Paste and seal {kind.displayName} credentials</h2>
      <p className="text-xs text-neutral-700">
        Each value is sealed client-side for the org members. The server never sees the cleartext.
      </p>
      {accessKeys.length === 0 ? (
        <p className="text-xs text-neutral-600">
          This resource kind has no `accessSchema` — no secrets to seal.
        </p>
      ) : null}
      {accessKeys.map((key) => {
        const spec = kind.accessSchema[key];
        const st = statuses[key] ?? 'pending';
        return (
          <div key={key} data-testid={`wizard-access-key-${key}`} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium">{key}</span>
              <span
                data-testid={`wizard-access-status-${key}`}
                className={`rounded px-1.5 py-0.5 ${st === 'sealed' ? 'bg-emerald-100 text-emerald-900' : 'bg-neutral-200 text-neutral-700'}`}
              >
                {st}
              </span>
              {spec?.description ? (
                <span className="text-neutral-600">— {spec.description}</span>
              ) : null}
            </div>
            {st !== 'sealed' ? (
              <SealedInput
                resourceId={resourceId}
                accessKey={key}
                onSealed={(blob) => handleSealed(key, blob)}
                onError={(msg) => {
                  setErrors((p) => ({ ...p, [key]: msg }));
                }}
              />
            ) : null}
            {errors[key] ? (
              <span data-testid={`wizard-access-error-${key}`} className="text-xs text-red-700">
                {errors[key]}
              </span>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-neutral-300 px-3 py-1 text-sm"
          data-testid="wizard-access-back"
        >
          Back
        </button>
        <button
          type="button"
          disabled={!allSealed && accessKeys.length > 0}
          onClick={onDone}
          data-testid="wizard-finish"
          className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {accessKeys.length === 0 ? 'Finish' : 'Finish (all keys sealed)'}
        </button>
      </div>
    </div>
  );
}
