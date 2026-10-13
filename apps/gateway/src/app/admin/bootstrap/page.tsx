/**
 * `/admin/bootstrap` — the first sign-in of whoever installs the gateway. It
 * accepts only the bootstrap token, only while it is active (spec §7.1).
 * Deliberately outside the guarded layout of Administration.
 */
import { redirect } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, ButtonLink, Callout, Field, Input, Mono } from '@/components/ui';
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
    // Outside every layout: the page carries the build line itself.
    <AuthPage instance={root.config.publicUrl.host} footer={<BuildFooter />}>
      <AuthHeading title="Set up this gateway">
        Sign in once with the bootstrap token of the configuration to connect the identity provider
        of your company. The token stops working as soon as the first administrator signs in through
        that provider.
      </AuthHeading>

      {error && isLoginErrorCode(error) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Refused" testId="bootstrap-error">
            {LOGIN_ERROR_MESSAGES[error]}
          </Callout>
        </div>
      )}

      {state.status === 'active' ? (
        <form method="post" action="/api/auth/bootstrap" className={styles.field}>
          <Field
            label="Bootstrap token"
            htmlFor="bootstrap-token"
            shape="32 characters or more"
            hint={
              <>
                The value of <Mono>VAUBAAN_BOOTSTRAP_TOKEN</Mono>, or of{' '}
                <Mono>bootstrap_token</Mono> in <Mono>gateway.yaml</Mono>.
              </>
            }
          >
            <Input
              id="bootstrap-token"
              type="password"
              name="token"
              required
              autoComplete="off"
              minLength={32}
              mono
            />
          </Field>
          <div className={styles.act}>
            <Button type="submit" variant="primary" size="lg">
              Sign in to set up
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.block}>
          <Callout
            tone="neutral"
            title={
              state.status === 'revoked'
                ? 'The bootstrap token no longer works'
                : 'This gateway has no bootstrap token'
            }
            testId="bootstrap-closed"
            action={
              <ButtonLink href="/login" size="sm">
                Sign in
              </ButtonLink>
            }
          >
            {state.status === 'revoked' ? (
              <>
                It was revoked on <LocalDate ts={state.revokedAt} />, when the first administrator
                signed in.
              </>
            ) : (
              'The identity provider is set in its configuration.'
            )}{' '}
            Administrators now sign in through the identity provider.
          </Callout>
        </div>
      )}
    </AuthPage>
  );
}
