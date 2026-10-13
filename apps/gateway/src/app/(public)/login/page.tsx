/**
 * `/login` — the default entry of the v5 interface: one button per configured
 * identity provider (one in v1), the account view with the operator marker
 * once signed in, and the closed error codes of a failed attempt.
 */
import Link from 'next/link';

import { PrincipalCard } from '@/components/auth/PrincipalCard';
import styles from '@/components/auth/auth.module.css';
import { Banner, Button, Card, CardBody } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const errorCode = first(params.error);
  const { root, principal } = await currentPrincipal();
  const idp = await root.auth.idp.current();
  const bootstrap = await root.auth.bootstrap.state();

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>{principal ? 'Signed in' : 'Sign in'}</h1>
      <p className={styles.lead}>
        {principal
          ? 'Your authority is recomputed from your current groups on every request.'
          : 'This instance delegates sign-in to your company identity provider.'}
      </p>

      {errorCode && isLoginErrorCode(errorCode) && (
        <Banner tone="danger" title="Sign-in failed">
          {LOGIN_ERROR_MESSAGES[errorCode]}
        </Banner>
      )}

      {principal ? (
        <PrincipalCard principal={principal} />
      ) : (
        <Card>
          <CardBody>
            {idp ? (
              <form method="get" action="/auth/login">
                <input type="hidden" name="return_to" value="/login" />
                <Button type="submit" variant="primary">
                  Continue with {idp.settings.issuer.hostname}
                </Button>
              </form>
            ) : (
              <>
                <p>No identity provider is configured yet.</p>
                {bootstrap.status === 'active' ? (
                  <p className={styles.muted}>
                    The operator signs in with the{' '}
                    <Link href="/admin/bootstrap">bootstrap token</Link> to configure it.
                  </p>
                ) : (
                  <p className={styles.muted}>Contact the operator of this instance.</p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
