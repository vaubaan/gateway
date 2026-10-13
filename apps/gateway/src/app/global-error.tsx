'use client';

/**
 * The root layout itself failed: this replaces the whole document. It carries
 * the style sheet and nothing that could fail the same way — no session, no
 * theme cookie (the page follows the system's theme).
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { Button, Mono } from '@/components/ui';

import './globals.css';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <AuthPage>
          <AuthHeading title="The gateway could not show this page">
            Nothing was changed by opening it. If it keeps happening, tell the administrator of this
            gateway.
          </AuthHeading>
          <div className={styles.act}>
            <Button variant="primary" size="lg" onClick={reset}>
              Try again
            </Button>
          </div>
          {error.digest && (
            <p className={styles.reference}>
              Reference <Mono>{error.digest}</Mono>
            </p>
          )}
        </AuthPage>
      </body>
    </html>
  );
}
