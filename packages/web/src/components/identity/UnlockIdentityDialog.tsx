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

import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/ui';

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
    <Dialog
      open={open}
      onClose={() => {
        /* dialog is dismissed only via submit; backdrop-close is a no-op here */
      }}
      dismissOnBackdropClick={false}
      ariaLabel={heading}
    >
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        aria-labelledby="unlock-identity-title"
      >
        <DialogHeader>
          <DialogTitle id="unlock-identity-title">{heading}</DialogTitle>
          <p className="text-sm text-muted">{blurb}</p>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="unlock-identity-password" className="block text-sm text-foreground">
            Password
          </label>
          <Input
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
            error={error !== null}
            className="mt-1"
          />
          {error !== null && (
            <p role="alert" className="mt-3 text-sm text-danger-foreground">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy || password.length === 0}
            loading={busy}
            className="w-full"
          >
            {busy ? 'Working...' : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
