/**
 * `/sign-in-account/create?token=…` — the invited person creates their sign-in account
 * (ADR local-accounts-sign-in-provider): the address the link was made for,
 * a password twice. A link that cannot be used any more says so and nothing
 * else; a refused form comes back on the same link.
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { accountErrorSentence, ChoosePasswordForm } from '@/components/auth/PasswordForm';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { ButtonLink, Callout } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import {
  ACCOUNT_ERROR_PARAM,
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

export default async function CreateAccountPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = first(params[LINK_TOKEN_PARAM]);
  const error = accountErrorSentence(first(params[ACCOUNT_ERROR_PARAM]));
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const link = token ? await root.auth.signInAccounts.inspectLink(token) : null;
  const usable = link !== null && link.kind === 'invite';

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading
        title={usable ? `Create your account on ${instance.label}` : 'This link cannot be used'}
      >
        {usable
          ? 'Choose the password you will sign in with. A second factor can be added from Settings afterwards; an administrator is asked for one at the first sign-in.'
          : SIGN_IN_ACCOUNT_ERROR_MESSAGES['link-invalid']}
      </AuthHeading>
      {error && (
        <div className={styles.block}>
          <Callout tone="bad" title="Not created" testId="account-error">
            {error}
          </Callout>
        </div>
      )}
      {usable ? (
        <ChoosePasswordForm
          action="/api/sign-in-account/create"
          token={token}
          email={link.email}
          submitLabel="Create my account"
        />
      ) : (
        <div className={styles.act}>
          <ButtonLink href="/login" variant="secondary" size="lg">
            Go to the sign-in page
          </ButtonLink>
        </div>
      )}
    </AuthPage>
  );
}
