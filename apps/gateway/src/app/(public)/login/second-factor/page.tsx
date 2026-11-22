/**
 * `/login/second-factor` — a sign-in continues with the enrolment of the
 * gateway's second factor (ADR administrators-live-in-the-instance, §7): the QR
 * code, the secret, the first code. Reachable only with the step cookie the sign-in
 * set, whatever the sign-in provider.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { EnrolSecondFactor } from '@/components/auth/SecondFactorForms';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Callout } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';
import { otpauthUrl } from '@/server/crypto/totp';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EnrolAtSignInPage({ searchParams }: Props) {
  const params = await searchParams;
  const { root } = await currentPrincipal();
  const step = await root.auth.sessions.peekLocalStep(await headers());
  if (step?.step !== 'enrol' || !step.totpSecret) redirect('/login?error=login-expired');
  const instance = await root.instance.name.identity();
  const error = typeof params.error === 'string' ? params.error : null;
  const otpauth = otpauthUrl({
    issuer: instance.label,
    account: step.login.email,
    secret: step.totpSecret,
  });

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title="Set up your second factor">
        {instance.label} asks a code of its own at each sign-in. Add it to an authenticator app,
        then enter the code it shows. Recovery codes come next; keep them safe — they are the way
        back when the app is not at hand.
      </AuthHeading>
      {error && isLoginErrorCode(error) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Not accepted" testId="login-error">
            {LOGIN_ERROR_MESSAGES[error]}
          </Callout>
        </div>
      )}
      <EnrolSecondFactor
        otpauth={otpauth}
        secret={step.totpSecret}
        action="/auth/factor/enrol"
        cancel={<Link href="/login">Start again</Link>}
      />
    </AuthPage>
  );
}
