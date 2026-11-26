'use client';

/**
 * The master key, read in the browser, proves the person holds it — and never leaves
 * the browser (ADR administrators-live-in-the-instance §9). Picked as the file the setup
 * handed over, or pasted. The page asks the gateway for a challenge, derives
 * `HKDF-SHA-256(key, info "vaubaan/recovery-proof/v1")` and sends `HMAC-SHA-256` of the
 * challenge (with the gateway's origin): the gateway computes the same with the key it
 * holds. On success the page reloads into what a recovery may do: on the recovery page,
 * name an administrator; on "Forgot your password?", choose a new password.
 */
import { useRef, useState } from 'react';

import { Button, Callout, Field, Input } from '@/components/ui';
import { postJson } from '@/lib/http/post-json';

import styles from './auth.styles';
import { keyBytes, proofOf } from './recovery-proof';

type State = 'idle' | 'working' | 'refused' | 'bad-file' | 'busy';

function challengeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('challenge' in body)) return null;
  return typeof body.challenge === 'string' ? body.challenge : null;
}

export function RecoverWithKey({ submitLabel = 'Continue' }: { submitLabel?: string }) {
  const [state, setState] = useState<State>('idle');
  const [pasted, setPasted] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function prove(text: string): Promise<void> {
    setState('working');
    const key = keyBytes(text);
    if (!key) {
      setState('bad-file');
      return;
    }
    const asked = await postJson('/api/recover/challenge');
    const challenge = asked.ok ? challengeOf(asked.body) : null;
    if (challenge === null) {
      key.fill(0);
      setState(asked.status === 429 ? 'busy' : 'refused');
      return;
    }
    const proof = await proofOf(key, window.location.origin, challenge);
    key.fill(0);
    const answered = await postJson('/api/recover/proof', { proof });
    if (answered.ok) {
      window.location.reload();
      return;
    }
    setState(answered.status === 429 ? 'busy' : 'refused');
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (file) await prove(await file.text());
  }

  const working = state === 'working';
  return (
    <div data-testid="recover-with-key" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <input
          ref={fileInput}
          id="master-key-file"
          type="file"
          accept=".txt,text/plain"
          className="sr-only"
          data-testid="master-key-file"
          disabled={working}
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={working}
          onClick={() => fileInput.current?.click()}
        >
          {working ? 'Checking…' : 'Choose the key file'}
        </Button>
        <p className={styles.muted}>
          vaubaan-master-key.txt, downloaded when this gateway was set up: usually in Downloads. It
          is read in this browser and never sent.
        </p>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void prove(pasted);
        }}
      >
        <Field label="Or paste the key" htmlFor="master-key-text">
          <Input
            id="master-key-text"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-testid="master-key-text"
            value={pasted}
            disabled={working}
            onChange={(event) => setPasted(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" disabled={working || pasted.trim() === ''}>
            {submitLabel}
          </Button>
        </div>
      </form>
      {state === 'bad-file' && (
        <Callout tone="bad" title="Not a master key" testId="recover-bad-file">
          The key is one line of 44 characters, as the gateway handed it over in
          vaubaan-master-key.txt.
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
