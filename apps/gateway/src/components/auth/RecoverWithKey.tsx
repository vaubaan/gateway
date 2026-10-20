'use client';

/**
 * The master key file, read in the browser, proves the person holds it — and never
 * leaves the browser (ADR administrators-live-in-the-instance §9). The page asks the
 * gateway for a challenge, derives `HKDF-SHA-256(key, info "vaubaan/recovery-proof/v1")`
 * and sends `HMAC-SHA-256` of the challenge (with the gateway's origin): the gateway
 * computes the same with the key it holds. On success the page reloads into the one
 * thing a recovery may do: name an administrator.
 */
import { useState } from 'react';

import { Button, Callout, Field } from '@/components/ui';

import { keyBytes, proofOf } from './recovery-proof';

export function RecoverWithKey() {
  const [state, setState] = useState<'idle' | 'working' | 'refused' | 'bad-file' | 'busy'>('idle');

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setState('working');
    const key = keyBytes(await file.text());
    if (!key) {
      setState('bad-file');
      return;
    }
    const asked = await fetch('/api/recover/challenge', { method: 'POST' });
    if (!asked.ok) {
      setState(asked.status === 429 ? 'busy' : 'refused');
      return;
    }
    const { challenge } = (await asked.json()) as { challenge: string };
    const proof = await proofOf(key, window.location.origin, challenge);
    key.fill(0);
    const answered = await fetch('/api/recover/proof', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof }),
    });
    if (answered.ok) {
      window.location.reload();
      return;
    }
    setState(answered.status === 429 ? 'busy' : 'refused');
  }

  return (
    <div data-testid="recover-with-key">
      <Field
        label="The master key file"
        htmlFor="master-key-file"
        hint="It is read here, in this browser, and never sent: the gateway checks a proof made with it."
      >
        <input
          id="master-key-file"
          type="file"
          accept=".txt,text/plain"
          data-testid="master-key-file"
          disabled={state === 'working'}
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </Field>
      {state === 'working' && <Button disabled>Checking…</Button>}
      {state === 'bad-file' && (
        <Callout tone="bad" title="Not a master key file" testId="recover-bad-file">
          The file must hold the 32 bytes of the key in base64, as the gateway handed it over.
        </Callout>
      )}
      {state === 'refused' && (
        <Callout tone="bad" title="Not this gateway’s key" testId="recover-refused">
          The proof does not match the key this gateway holds now (a key rotated since is not it).
        </Callout>
      )}
      {state === 'busy' && (
        <Callout tone="bad" title="Too many attempts" testId="recover-busy">
          Wait a few minutes, then try again.
        </Callout>
      )}
    </div>
  );
}
