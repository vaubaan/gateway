'use client';

/**
 * Modal that asks the user for their password so the browser can
 * derive the KEK and unwrap the X25519 private key (spec §4.1, step 3).
 *
 * The password is held in component state only for the duration of the
 * submit. The dialog itself never persists it — it forwards the value
 * to `onSubmit`, then wipes the local state.
 */

import { useState, type FormEvent, type ReactElement } from 'react';

export interface UnlockIdentityDialogProps {
  open: boolean;
  mode: 'unlock' | 'first-login';
  onSubmit: (password: string) => Promise<void> | void;
  onError?: (err: Error) => void;
}

export function UnlockIdentityDialog(props: UnlockIdentityDialogProps): ReactElement | null {
  const { open, mode, onSubmit, onError } = props;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let pw = password;
    try {
      await onSubmit(pw);
      pw = '';
      setPassword('');
    } catch (err) {
      pw = '';
      setPassword('');
      const errObj = err instanceof Error ? err : new Error('unlock failed');
      setError(errObj.message);
      onError?.(errObj);
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === 'first-login' ? 'Set up your crypto identity' : 'Unlock your identity';
  const blurb =
    mode === 'first-login'
      ? 'Generating your crypto identity for the first time on this device. Your password derives the key that wraps your private key — Vauban never sees it in clear.'
      : 'Enter your password to unwrap your private key on this device. The key stays in memory only; it is wiped on logout.';
  const submitLabel = mode === 'first-login' ? 'Generate identity' : 'Unlock';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-identity-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl"
      >
        <h2 id="unlock-identity-title" className="text-lg font-semibold text-neutral-100">
          {heading}
        </h2>
        <p className="mt-2 text-sm text-neutral-400">{blurb}</p>
        <label htmlFor="unlock-identity-password" className="mt-6 block text-sm text-neutral-300">
          Password
        </label>
        <input
          id="unlock-identity-password"
          type="password"
          autoComplete="off"
          autoFocus
          required
          disabled={busy}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
        />
        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mt-6 w-full rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Working...' : submitLabel}
        </button>
      </form>
    </div>
  );
}
