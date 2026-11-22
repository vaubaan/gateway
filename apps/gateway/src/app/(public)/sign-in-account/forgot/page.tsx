/**
 * `/sign-in-account/forgot` — "Forgot your password" (ADR local-accounts-sign-in-provider).
 * The answer is the same for every address: it never says whether an account
 * exists. When the instance sends no mail, the page says so beforehand and
 * points at an administrator, who can hand a reset link over from People.
 */
import Link from 'next/link';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, Callout, Field, Input } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { FORGOT_SENT_PARAM } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ForgotPasswordPage({ searchParams }: Props) {
  const params = await searchParams;
  const sent = params[FORGOT_SENT_PARAM] !== undefined;
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const local = (await root.auth.signInProviders.views()).some((p) => p.kind === 'local');
  const sendsMail = root.auth.sendsMail;

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title="Forgot your password?">
        {!local
          ? 'This gateway keeps no sign-in accounts: you sign in through a sign-in provider, which keeps your password.'
          : sendsMail
            ? 'Enter the address of your account. If it has one, a link to choose a new password is sent to it; it works once, for fifteen minutes.'
            : 'This gateway sends no mail. Ask an administrator: they can hand you a link to choose a new password.'}
      </AuthHeading>
      {sent && (
        <div className={styles.block}>
          <Callout tone="ok" title="Done" testId="forgot-sent">
            If an account exists for this address, a link was sent to it. Check the mailbox, the
            spam folder included; the link works for fifteen minutes.
          </Callout>
        </div>
      )}
      {local && sendsMail && !sent ? (
        <form method="post" action="/api/sign-in-account/forgot" className={styles.field}>
          <Field label="Email address" htmlFor="forgot-email">
            <Input
              id="forgot-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
            />
          </Field>
          <div className={styles.act}>
            <Button type="submit" variant="primary" size="lg">
              Send me a link
            </Button>
            <Link href="/login">Back to sign-in</Link>
          </div>
        </form>
      ) : (
        <div className={styles.act}>
          <Link href="/login">Back to sign-in</Link>
        </div>
      )}
    </AuthPage>
  );
}
