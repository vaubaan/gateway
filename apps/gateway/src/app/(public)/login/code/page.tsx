/**
 * `/login/code` — the second factor of a local sign-in (ADR
 * local-accounts-sign-in-provider): the code of the authenticator app, or a
 * recovery code. Reachable only with the step cookie the password form set;
 * without it, back to the sign-in page.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { SecondFactorCodeForm } from '@/components/auth/SecondFactorForms';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Callout } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SecondFactorPage({ searchParams }: Props) {
  const params = await searchParams;
  const { root } = await currentPrincipal();
  const step = await root.auth.sessions.peekLocalStep(await headers());
  if (step?.step !== 'second-factor') redirect('/login?error=login-expired');
  const instance = await root.instance.name.identity();
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title="One more step">
        Enter the code your authenticator app shows for {instance.label}.
      </AuthHeading>
      {error && isLoginErrorCode(error) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Not accepted" testId="login-error">
            {LOGIN_ERROR_MESSAGES[error]}
          </Callout>
        </div>
      )}
      <SecondFactorCodeForm
        action={`/auth/local/${encodeURIComponent(step.providerId)}/code`}
        submitLabel="Sign in"
        withRecovery
        cancel={<Link href="/login">Start again</Link>}
      />
    </AuthPage>
  );
}
