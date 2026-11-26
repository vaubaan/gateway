/**
 * `/sign-in-account/forgot` — "Forgot your password" (ADR local-accounts-sign-in-provider;
 * ADR administrators-live-in-the-instance, amendment 2026-11-26). Three states:
 *
 * - the instance sends mail: the address, one answer for every address (it never says
 *   whether an account exists), and "Use my encryption key" as the other way;
 * - it sends none, or the person chose the key (`?with=key`): the master key, picked as
 *   its file or pasted, proven in the browser (`RecoverWithKey`);
 * - this browser holds a recovery session: the account and a new password, after which
 *   the person is signed in (`POST /api/recover/password`).
 */
import Link from 'next/link';
import { cookies } from 'next/headers';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { accountErrorSentence } from '@/components/auth/PasswordForm';
import { RecoverWithKey } from '@/components/auth/RecoverWithKey';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, Callout, Field, Input, Select } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { ACCOUNT_ERROR_PARAM, FORGOT_PASSWORD_PAGE, FORGOT_SENT_PARAM } from '@/server/auth';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';

export const dynamic = 'force-dynamic';

/** `?with=key`: the person chose the encryption key over a mailed link. */
const WITH_PARAM = 'with';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export default async function ForgotPasswordPage({ searchParams }: Props) {
  const params = await searchParams;
  const sent = params[FORGOT_SENT_PARAM] !== undefined;
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const localView = (await root.auth.signInProviders.views()).find((p) => p.kind === 'local');
  const sendsMail = root.auth.sendsMail;
  const jar = await cookies();
  const headers = new Headers({
    cookie: jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  });
  const recovering = localView !== undefined && (await root.auth.recovery.isOpen(headers));
  const withKey = localView !== undefined && (!sendsMail || first(params[WITH_PARAM]) === 'key');
  const error = accountErrorSentence(first(params[ACCOUNT_ERROR_PARAM]));

  if (recovering) {
    const accounts = await root.auth.signInAccounts.list(localView.id);
    return (
      <AuthPage instance={instance} footer={<BuildFooter />}>
        <AuthHeading title="Choose a new password">
          The key is this gateway’s. Choose the new password: you are signed in right after, and
          every session open with the former one ends. This lasts fifteen minutes.
        </AuthHeading>
        {error && (
          <div className={styles.block}>
            <Callout tone="bad" title="Not changed" testId="account-error">
              {error}
            </Callout>
          </div>
        )}
        <form
          method="post"
          action="/api/recover/password"
          className={styles.field}
          data-testid="recover-password"
        >
          {accounts.length === 1 ? (
            <>
              <input type="hidden" name="sign_in_account" value={accounts[0]!.id} />
              <Field label="Email address" htmlFor="local-email">
                <Input
                  id="local-email"
                  type="email"
                  value={accounts[0]!.email}
                  readOnly
                  autoComplete="username"
                />
              </Field>
            </>
          ) : (
            <Field label="The account" htmlFor="recover-account">
              <Select id="recover-account" name="sign_in_account" required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="New password"
            htmlFor="local-password"
            shape={`${PASSWORD_MIN_LENGTH} characters or more`}
            hint="Any characters; length is what counts. A sentence you can remember is a good one."
          >
            <Input
              id="local-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
              autoFocus
            />
          </Field>
          <Field label="The same password again" htmlFor="local-password-again">
            <Input
              id="local-password-again"
              name="password_again"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </Field>
          <div className={styles.act}>
            <Button type="submit" variant="primary" size="lg">
              Set the password and sign in
            </Button>
          </div>
        </form>
      </AuthPage>
    );
  }

  if (withKey) {
    return (
      <AuthPage instance={instance} footer={<BuildFooter />}>
        <AuthHeading title="Forgot your password?">
          {sendsMail
            ? 'Use the encryption key of this gateway to choose a new password, with no mail.'
            : 'This gateway sends no mail: its encryption key, the one you kept at the setup, lets you choose a new password.'}
        </AuthHeading>
        <div className={styles.block}>
          <RecoverWithKey />
        </div>
        <div className={styles.act}>
          <Link href="/login">Back to sign-in</Link>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title="Forgot your password?">
        {!localView
          ? 'This gateway keeps no sign-in accounts: you sign in through a sign-in provider, which keeps your password.'
          : 'Enter the address of your account. If it has one, a link to choose a new password is sent to it; it works once, for fifteen minutes.'}
      </AuthHeading>
      {sent && (
        <div className={styles.block}>
          <Callout tone="ok" title="Done" testId="forgot-sent">
            If an account exists for this address, a link was sent to it. Check the mailbox, the
            spam folder included; the link works for fifteen minutes.
          </Callout>
        </div>
      )}
      {localView && !sent ? (
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
            <Link href={`${FORGOT_PASSWORD_PAGE}?${WITH_PARAM}=key`}>Use my encryption key</Link>
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
