'use client';

/**
 * A page outside the application shell failed while rendering (the sign-in,
 * the first sign-in of an installation). Same answer as inside the shell, in
 * the frame of those pages.
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { Button, Mono } from '@/components/ui';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AuthPage>
      <AuthHeading title="This page could not be shown">
        Nothing was changed by opening it. If it keeps happening, tell the administrator of this
        gateway.
      </AuthHeading>
      <div className={styles.act}>
        <Button variant="primary" size="lg" onClick={reset}>
          Try again
        </Button>
      </div>
      {error.digest && (
        <p className={styles.reference} data-testid="error-reference">
          Reference <Mono>{error.digest}</Mono>
        </p>
      )}
    </AuthPage>
  );
}
