/**
 * `<SealedReveal>` — unseal a `SealedBlobV1` for the current user.
 *
 * Two modes (spec §11.2) :
 *
 * - `mode='copy'` — copies the cleartext to the clipboard and wipes
 *   the in-memory copy immediately. The cleartext **never** lands in
 *   React state. The clipboard is left to the OS — we cannot wipe it
 *   from JS, but most browsers expose a way to clear it (cf. tooltip).
 * - `mode='reveal'` — renders the cleartext with a "show/hide" toggle.
 *   The reveal is auto-hidden after `autoHideMs` (default 30 000 ms).
 *
 * In both modes the identity (private key) is pulled from
 * `identityStore` (memory-only singleton from Phase 2). If the user's
 * fingerprint is NOT among the blob's recipients, the component
 * surfaces `not_a_recipient` and renders nothing else.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { decodeUtf8, unsealAs, type SealedBlobV1 } from '@crm/core/crypto';

import { Button } from '@/components/ui';
import { identityStore } from '@/lib/crypto/identity-store';

export interface SealedRevealProps {
  readonly blob: SealedBlobV1;
  readonly mode: 'copy' | 'reveal';
  readonly autoHideMs?: number;
  readonly onError?: (code: string) => void;
}

type RevealState =
  | { kind: 'idle' }
  | { kind: 'unlocked'; cleartext: string }
  | { kind: 'error'; code: string };

const DEFAULT_AUTO_HIDE_MS = 30_000;

export function SealedReveal(props: SealedRevealProps): React.ReactElement {
  const { blob, mode, autoHideMs, onError } = props;
  const [state, setState] = useState<RevealState>({ kind: 'idle' });
  const [shown, setShown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const surfaceError = useCallback(
    (code: string) => {
      setState({ kind: 'error', code });
      onError?.(code);
    },
    [onError],
  );

  const reveal = useCallback(async () => {
    const id = identityStore.get();
    if (!id) {
      surfaceError('identity_locked');
      return;
    }
    const plain = await unsealAs(blob, id.fingerprint, {
      publicKey: id.publicKey,
      privateKey: id.privateKey,
    });
    if (plain === null) {
      surfaceError('not_a_recipient');
      return;
    }
    const text = decodeUtf8(plain);
    plain.fill(0);
    if (mode === 'copy') {
      try {
        await navigator.clipboard.writeText(text);
        setState({ kind: 'idle' });
      } catch (e) {
        surfaceError(e instanceof Error ? e.message : 'clipboard_failed');
      }
      return;
    }
    setState({ kind: 'unlocked', cleartext: text });
    setShown(true);
    const ms = autoHideMs ?? DEFAULT_AUTO_HIDE_MS;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setShown(false);
      setState({ kind: 'idle' });
    }, ms);
  }, [autoHideMs, blob, mode, surfaceError]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (state.kind === 'error') {
    return (
      <div data-testid="sealed-reveal-error" className="text-sm text-danger-foreground">
        {state.code === 'not_a_recipient'
          ? 'You are not a recipient of this sealed value.'
          : state.code === 'identity_locked'
            ? 'Unlock your identity to reveal this value.'
            : `Error: ${state.code}`}
      </div>
    );
  }

  if (state.kind === 'unlocked' && shown) {
    return (
      <div data-testid="sealed-reveal-shown" className="flex flex-col gap-2">
        <pre className="overflow-x-auto rounded bg-sunken px-2 py-1 font-mono text-xs">
          {state.cleartext}
        </pre>
        <Button
          type="button"
          variant="link"
          size="sm"
          data-testid="sealed-reveal-hide"
          onClick={() => {
            setShown(false);
            setState({ kind: 'idle' });
            if (timerRef.current) clearTimeout(timerRef.current);
          }}
          className="self-start"
        >
          Hide
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-testid={mode === 'copy' ? 'sealed-reveal-copy' : 'sealed-reveal-show'}
      onClick={() => void reveal()}
    >
      {mode === 'copy' ? 'Copy' : 'Reveal'}
    </Button>
  );
}
