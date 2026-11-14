/**
 * `/sign-in-account/reset?token=…` — a new password on a reset link (ADR
 * local-accounts-sign-in-provider). A link that cannot be used any more says
 * so and nothing else.
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { accountErrorSentence, ChoosePasswordForm } from '@/components/auth/PasswordForm';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { ButtonLink, Callout } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import {
  ACCOUNT_ERROR_PARAM,
  FORGOT_PASSWORD_PAGE,
  LINK_TOKEN_PARAM,
  SIGN_IN_ACCOUNT_ERROR_MESSAGES,
} from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export default async function ResetPasswordPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = first(params[LINK_TOKEN_PARAM]);
  const error = accountErrorSentence(first(params[ACCOUNT_ERROR_PARAM]));
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const link = token ? await root.auth.signInAccounts.inspectLink(token) : null;
  const usable = link !== null && link.kind === 'reset';

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title={usable ? 'Choose a new password' : 'This link cannot be used'}>
        {usable
          ? 'The sessions you have open stay open; the next sign-in takes the new password.'
          : SIGN_IN_ACCOUNT_ERROR_MESSAGES['link-invalid']}
      </AuthHeading>
      {error && (
        <div className={styles.block}>
          <Callout tone="bad" title="Not changed" testId="account-error">
            {error}
          </Callout>
        </div>
      )}
      {usable ? (
        <ChoosePasswordForm
          action="/api/sign-in-account/reset"
          token={token}
          email={link.email}
          submitLabel="Set the password"
        />
      ) : (
        <div className={styles.act}>
          <ButtonLink href={FORGOT_PASSWORD_PAGE} variant="secondary" size="lg">
            Ask for another link
          </ButtonLink>
        </div>
      )}
    </AuthPage>
  );
}
