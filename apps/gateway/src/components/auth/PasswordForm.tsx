/**
 * The forms of the local accounts, outside the shell (ADR
 * local-accounts-sign-in-provider): the sign-in form of the sign-in page, and
 * the "choose a password" form of the create-account and reset pages. Plain
 * HTML forms; the server validates everything again.
 */
import Link from 'next/link';

import styles from '@/components/auth/auth.module.css';
import { Button, Field, Input } from '@/components/ui';
import {
  FORGOT_PASSWORD_PAGE,
  LINK_TOKEN_PARAM,
  LOCAL_ACCOUNT_ERROR_CODES,
  LOCAL_ACCOUNT_ERROR_MESSAGES,
  type LocalAccountErrorCode,
} from '@/server/auth';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';

/** The sentence of a refused form: a closed code, or the one the handler adds for a mismatch. */
export function accountErrorSentence(code: string): string | null {
  if (code === 'password-mismatch') return 'The two passwords differ. Type the same one twice.';
  return (LOCAL_ACCOUNT_ERROR_CODES as readonly string[]).includes(code)
    ? LOCAL_ACCOUNT_ERROR_MESSAGES[code as LocalAccountErrorCode]
    : null;
}

export function PasswordSignInForm({
  action,
  returnTo,
  heading,
}: {
  /** `/auth/local/<provider>`. */
  action: string;
  returnTo: string;
  /** The provider's name: "Sign in with <name>". */
  heading: string;
}) {
  return (
    <form method="post" action={action} className={styles.field} data-testid="password-sign-in">
      <input type="hidden" name="return_to" value={returnTo} />
      <p className={styles.sentence}>{heading}</p>
      <Field label="Email address" htmlFor="local-email">
        <Input
          id="local-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
        />
      </Field>
      <Field label="Password" htmlFor="local-password">
        <Input
          id="local-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <div className={styles.act}>
        <Button type="submit" variant="primary" size="lg">
          Sign in
        </Button>
        <Link href={FORGOT_PASSWORD_PAGE}>Forgot your password?</Link>
      </div>
    </form>
  );
}

export function ChoosePasswordForm({
  action,
  token,
  email,
  submitLabel,
}: {
  /** `/api/account/create` or `/api/account/reset`. */
  action: string;
  token: string;
  /** Shown, not editable: the address the link was made for. */
  email: string;
  submitLabel: string;
}) {
  return (
    <form method="post" action={action} className={styles.field} data-testid="choose-password">
      <input type="hidden" name={LINK_TOKEN_PARAM} value={token} />
      <Field label="Email address" htmlFor="local-email">
        <Input id="local-email" type="email" value={email} readOnly autoComplete="username" />
      </Field>
      <Field
        label="Password"
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
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
