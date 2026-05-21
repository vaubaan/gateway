/**
 * `<SealedInput>` — secret entry that seals client-side before posting.
 *
 * Contract (spec §11.2) :
 *
 *   <SealedInput
 *     resourceId="<uuid>"
 *     accessKey="GITHUB_TOKEN"
 *     onSealed={(blob) => api.put(...)}
 *   />
 *
 * Lifecycle :
 *
 * 1. On mount → fetch the default recipient list (`/recipients`).
 *    Recipients are rendered with their fingerprint + optional user_id
 *    so the operator can visually validate before sealing (TOFU,
 *    spec §4.4).
 * 2. The operator pastes the cleartext into a textarea (`autocomplete="off"`,
 *    `spellcheck=false`). A "Seal" button is enabled when recipients
 *    are loaded and the textarea is non-empty.
 * 3. On submit : encode the cleartext to UTF-8 bytes, call
 *    `sealForRecipients` from `@crm/core/crypto`, hand the resulting
 *    `SealedBlobV1` to the `onSealed` callback. After resolution, the
 *    textarea is wiped (`setValue('')`), the underlying ref's value is
 *    reset, and the focused state is restored to "ready to seal a
 *    fresh value".
 *
 * ZK invariants enforced :
 *
 * - The cleartext bytes never leave the function scope of `handleSeal`.
 *   After sealing, the cleartext `Uint8Array` is overwritten with zeros
 *   (`bytes.fill(0)`) before the function returns.
 * - No localStorage / sessionStorage / IndexedDB / document.cookie
 *   write touches the cleartext (audit grep enforced in tests).
 */

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { sealForRecipients, type PubKeyEntry, type SealedBlobV1 } from '@crm/core/crypto';

import { useDefaultRecipients, type RecipientEntry } from '@/lib/sealed/use-default-recipients';

export interface SealedInputProps {
  readonly resourceId: string;
  readonly accessKey: string;
  /**
   * Optional placeholder shown in the textarea. Should never contain the
   * actual secret format; just a hint like "github_pat_...".
   */
  readonly placeholder?: string;
  /** Optional human label override (defaults to `accessKey`). */
  readonly label?: string;
  /** Called after a successful seal — receives the canonical blob. */
  readonly onSealed: (blob: SealedBlobV1) => Promise<void>;
  /** Called if the seal step itself fails. */
  readonly onError?: (message: string) => void;
}

interface SealUiState {
  readonly disabledFingerprints: ReadonlySet<string>;
}

function selectedRecipients(
  all: ReadonlyArray<RecipientEntry>,
  disabled: ReadonlySet<string>,
): PubKeyEntry[] {
  return all
    .filter((r) => !disabled.has(r.fingerprint))
    .map((r) => ({ publicKey: r.publicKey, fingerprint: r.fingerprint }));
}

export function SealedInput(props: SealedInputProps): React.ReactElement {
  const { resourceId, accessKey, placeholder, label, onSealed, onError } = props;
  const recipientsHook = useDefaultRecipients(resourceId, accessKey);
  const { status, recipients, error } = recipientsHook;

  const [value, setValue] = useState('');
  const [ui, setUi] = useState<SealUiState>({ disabledFingerprints: new Set() });
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeRecipients = useMemo(
    () => selectedRecipients(recipients, ui.disabledFingerprints),
    [recipients, ui.disabledFingerprints],
  );

  const toggleRecipient = useCallback((fp: string, checked: boolean) => {
    setUi((prev) => {
      const next = new Set(prev.disabledFingerprints);
      if (checked) next.delete(fp);
      else next.add(fp);
      return { disabledFingerprints: next };
    });
  }, []);

  const handleSeal = useCallback(async () => {
    if (value.length === 0) return;
    if (activeRecipients.length === 0) {
      onError?.('seal_requires_at_least_one_recipient');
      return;
    }
    setBusy(true);
    let bytes: Uint8Array | null = null;
    try {
      bytes = new TextEncoder().encode(value);
      const blob = await sealForRecipients(bytes, activeRecipients);
      // Wipe the local-scope cleartext bytes before yielding.
      bytes.fill(0);
      bytes = null;
      // Hand the sealed bundle off. The caller is responsible for the
      // network round-trip.
      await onSealed(blob);
      setValue('');
      if (textareaRef.current) textareaRef.current.value = '';
    } catch (e) {
      onError?.(e instanceof Error ? e.message : 'seal_failed');
    } finally {
      // Best-effort second wipe (in case onSealed threw before the first
      // fill or the engine kept a reference).
      if (bytes) bytes.fill(0);
      setBusy(false);
    }
  }, [value, activeRecipients, onSealed, onError]);

  const displayedLabel = label ?? accessKey;

  return (
    <div
      data-testid="sealed-input"
      data-status={status}
      data-recipient-count={String(activeRecipients.length)}
      className="flex flex-col gap-3 rounded-md border border-neutral-300 p-4"
    >
      <label className="text-sm font-medium" htmlFor={`sealed-input-${accessKey}`}>
        {displayedLabel}
      </label>
      <textarea
        ref={textareaRef}
        id={`sealed-input-${accessKey}`}
        data-testid="sealed-input-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        rows={3}
        className="w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-sm"
        placeholder={placeholder ?? 'paste secret here'}
      />

      <fieldset data-testid="sealed-input-recipients" className="flex flex-col gap-1 text-xs">
        <legend className="font-medium text-neutral-700">
          Recipients ({String(activeRecipients.length)} / {String(recipients.length)})
        </legend>
        {status === 'loading' ? <span>Loading recipient list…</span> : null}
        {status === 'error' ? (
          <span data-testid="sealed-input-recipients-error" className="text-red-700">
            Failed to load recipients: {error ?? 'unknown'} —{' '}
            <button type="button" onClick={() => void recipientsHook.refresh()}>
              retry
            </button>
          </span>
        ) : null}
        {status === 'ready' && recipients.length === 0 ? (
          <span>
            No recipients available. A keypair must be created by at least one org member before
            secrets can be sealed.
          </span>
        ) : null}
        {recipients.map((r) => {
          const checked = !ui.disabledFingerprints.has(r.fingerprint);
          return (
            <label key={r.fingerprint} className="flex items-center gap-2 font-mono">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  toggleRecipient(r.fingerprint, e.target.checked);
                }}
                data-testid={`recipient-checkbox-${r.fingerprint}`}
              />
              <span data-testid={`recipient-fp-${r.fingerprint}`}>
                {r.userId ? `${r.userId} · ` : ''}
                {r.fingerprint}
              </span>
            </label>
          );
        })}
      </fieldset>

      <button
        type="button"
        data-testid="sealed-input-seal"
        disabled={busy || status !== 'ready' || activeRecipients.length === 0 || value.length === 0}
        onClick={() => void handleSeal()}
        className="self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Sealing…' : 'Seal'}
      </button>
    </div>
  );
}
