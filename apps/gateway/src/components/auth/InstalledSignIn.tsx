'use client';

/**
 * The buttons of the sign-in providers a local instance carries (Google, Microsoft,
 * GitHub; ADR local-instance-carries-installed-oauth-clients). A click asks the gateway to
 * start a flow (`POST /auth/loopback/start`), then sends the window to the provider's
 * consent page. A browser follows it and comes back signed in. The desktop app opens it
 * in the default browser and keeps this page: it then polls `/auth/loopback/status` until
 * the consent is given in the browser, and goes where the gateway says.
 */
import { useEffect, useRef, useState } from 'react';

import { Button, Callout } from '@/components/ui';

import styles from './auth.styles';

export interface InstalledProviderButton {
  readonly id: string;
  readonly name: string;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly id: string }
  | { readonly kind: 'waiting'; readonly name: string }
  | { readonly kind: 'failed'; readonly message: string };

const POLL_MS = 1500;
/** As long as the gateway keeps the flow: ten minutes. */
const GIVE_UP_MS = 10 * 60_000;

function field(body: unknown, name: string): string | null {
  if (typeof body !== 'object' || body === null || !(name in body)) return null;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

async function post(url: string, form?: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  return response.json().catch(() => null);
}

export function InstalledSignIn({
  providers,
  purpose,
  returnTo,
  primary = false,
}: {
  readonly providers: readonly InstalledProviderButton[];
  readonly purpose: 'sign-in' | 'setup';
  readonly returnTo: string;
  /** The first button is the page's main action. */
  readonly primary?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function poll(until: number): void {
    timer.current = setTimeout(() => void check(until), POLL_MS);
  }

  async function check(until: number): Promise<void> {
    let body: unknown = null;
    try {
      body = await post('/auth/loopback/status');
    } catch {
      // expected: the gateway restarting: the next poll tries again.
    }
    const status = field(body, 'status');
    if (status === 'done') {
      window.location.assign(field(body, 'location') ?? '/');
      return;
    }
    if (status === 'none' || Date.now() > until) {
      setState({ kind: 'failed', message: 'The sign-in expired. Start again.' });
      return;
    }
    poll(until);
  }

  async function start(provider: InstalledProviderButton): Promise<void> {
    setState({ kind: 'starting', id: provider.id });
    let body: unknown = null;
    try {
      body = await post('/auth/loopback/start', {
        signInProvider: provider.id,
        purpose,
        return_to: returnTo,
      });
    } catch {
      // expected: an unreachable gateway leaves no authorizeUrl, reported below
    }
    const authorizeUrl = field(body, 'authorizeUrl');
    if (!authorizeUrl) {
      setState({
        kind: 'failed',
        message: `${provider.name} could not be reached from this gateway. Try again in a moment.`,
      });
      return;
    }
    setState({ kind: 'waiting', name: provider.name });
    // A browser leaves this page; the desktop app opens the address in the default
    // browser and stays here, polling until the consent is given there.
    window.location.assign(authorizeUrl);
    poll(Date.now() + GIVE_UP_MS);
  }

  return (
    <>
      <div className={styles.act} data-testid="installed-sign-in">
        {providers.map((provider, index) => (
          <Button
            key={provider.id}
            type="button"
            variant={primary && index === 0 ? 'primary' : 'secondary'}
            size="lg"
            disabled={state.kind === 'starting' || state.kind === 'waiting'}
            onClick={() => void start(provider)}
            data-testid={`installed-sign-in-${provider.id}`}
          >
            Continue with {provider.name}
          </Button>
        ))}
      </div>
      {state.kind === 'waiting' && (
        <div className={styles.block}>
          <Callout tone="neutral" title={`Finish with ${state.name}`} testId="installed-waiting">
            If {state.name} opened in your browser, sign in there: this window goes on by itself
            once you have.
          </Callout>
        </div>
      )}
      {state.kind === 'failed' && (
        <div className={styles.block}>
          <Callout tone="bad" title="Sign-in failed" testId="installed-failed">
            {state.message}
          </Callout>
        </div>
      )}
    </>
  );
}
