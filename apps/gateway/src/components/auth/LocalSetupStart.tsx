'use client';

/**
 * The start of the setup of an instance in local mode (ADR
 * local-mode-for-an-instance-on-this-computer): the desktop app and the docker
 * command hand the person a setup link, so the token is never theirs to see,
 * keep or type. With the link, one button; without it, how to get it. The token
 * is taken out of the address bar as soon as it is read.
 */
import { useEffect, useState } from 'react';

import { Button, Callout, Mono } from '@/components/ui';

import styles from './auth.styles';
import { setupLinkWithoutToken, tokenFromSetupLink } from './setup-link';

export function LocalSetupStart() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const read = () => {
      const found = tokenFromSetupLink(window.location.href);
      // A link pasted over this page changes the fragment only: a token already read stays.
      setToken((before) => found ?? before ?? null);
      if (found) {
        window.history.replaceState(
          window.history.state,
          '',
          setupLinkWithoutToken(window.location.href),
        );
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Before the address is read: nothing to choose yet.
  if (token === undefined) return null;

  if (token === null) {
    return (
      <div className={styles.block}>
        <Callout tone="neutral" title="Open the setup link" testId="local-setup-no-link">
          In the Vaubaan app, quit and open it again. With Docker, run{' '}
          <Mono>docker logs vaubaan</Mono> and open the link it prints.
        </Callout>
      </div>
    );
  }

  return (
    <form method="post" action="/api/auth/bootstrap" className={styles.field}>
      <input type="hidden" name="token" value={token} />
      <div className={styles.act}>
        <Button type="submit" variant="primary" size="lg" data-testid="local-setup-start">
          Start
        </Button>
      </div>
    </form>
  );
}
