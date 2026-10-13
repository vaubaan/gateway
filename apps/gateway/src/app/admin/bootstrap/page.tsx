/**
 * `/admin/bootstrap` — accepts only the bootstrap token, only while it is
 * active (spec §7.1). Deliberately outside the guarded admin layout.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import styles from '@/components/auth/auth.module.css';
import { Banner, Button, Card, CardBody, Field, Input } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BootstrapPage({ searchParams }: Props) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : null;
  const { root, principal } = await currentPrincipal();
  if (principal?.kind === 'bootstrap') redirect('/admin');
  const state = await root.auth.bootstrap.state();

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Operator bootstrap</h1>
      <p className={styles.lead}>
        Sign in with the <code>bootstrap_token</code> of the instance configuration to set up the
        identity provider. The token is revoked automatically after the first operator signs in
        through the identity provider.
      </p>

      {error && isLoginErrorCode(error) && (
        <Banner tone="danger" title="Refused">
          {LOGIN_ERROR_MESSAGES[error]}
        </Banner>
      )}

      <Card>
        <CardBody>
          {state.status === 'active' ? (
            <form method="post" action="/api/auth/bootstrap">
              <Field
                label="Bootstrap token"
                hint="VAUBAAN_BOOTSTRAP_TOKEN or bootstrap_token in gateway.yaml"
              >
                <Input type="password" name="token" required autoComplete="off" minLength={32} />
              </Field>
              <Button type="submit" variant="primary">
                Sign in as operator
              </Button>
            </form>
          ) : (
            <>
              <p>
                {state.status === 'revoked'
                  ? `The bootstrap token was revoked on ${state.revokedAt}.`
                  : 'This instance has no bootstrap token: the identity provider is set in its configuration.'}
              </p>
              <p className={styles.muted}>
                Operators now <Link href="/login">sign in through the identity provider</Link>.
              </p>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
