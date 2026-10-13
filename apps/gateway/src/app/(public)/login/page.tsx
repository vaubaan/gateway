/**
 * `/login` — the entry of the interface: one button for the identity provider
 * of the company, the closed error codes of a failed attempt, and, once signed
 * in, who is signed in and where to go.
 *
 * It checks nothing itself: the session is the authenticator's, and what a
 * person may do is recomputed from their groups on every request.
 */
import Link from 'next/link';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { isOperatorPrincipal } from '@/components/auth/principal';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Avatar, Button, ButtonLink, Callout, StatusMark } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { ACTIONS, ROLE_WORDS, ROUTES } from '@/lib/vocabulary';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES, type Principal } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Who is signed in, and what they are here when it is more than a person. */
function SignedIn({ principal }: { principal: Principal }) {
  const user = principal.kind === 'user' ? principal.user : null;
  const name = user ? (user.displayName ?? user.email) : 'Bootstrap token';
  return (
    <>
      <div className={styles.who} data-testid="signed-in-as">
        <div className={styles.whoName}>
          {user && <Avatar name={name} />}
          <span>{name}</span>
          {principal.kind === 'bootstrap' && (
            <StatusMark tone="warn">{ROLE_WORDS.installer}</StatusMark>
          )}
          {principal.kind === 'user' && principal.isOperator && (
            <StatusMark dot={false}>{ROLE_WORDS.administrator}</StatusMark>
          )}
        </div>
        <div className={styles.whoFacts}>
          {principal.kind === 'user' ? (
            <>
              {user?.displayName && <>{user.email} · </>}
              {principal.groups.length === 0
                ? 'in no team'
                : `in ${principal.groups.map((group) => group.name).join(', ')}`}
            </>
          ) : (
            'The bootstrap token sets up sign-in and owns nothing: connect your identity provider, then sign in through it.'
          )}
        </div>
      </div>
      <div className={styles.act}>
        {principal.kind === 'user' ? (
          <ButtonLink href={ROUTES.home} variant="primary" size="lg">
            Open the gateway
          </ButtonLink>
        ) : (
          <ButtonLink href={ROUTES.administration} variant="primary" size="lg">
            Set up sign-in
          </ButtonLink>
        )}
        {principal.kind === 'user' && isOperatorPrincipal(principal) && (
          <Link href={ROUTES.settings}>Settings</Link>
        )}
        <form method="post" action="/logout">
          <Button type="submit" variant="ghost" size="lg">
            {ACTIONS.signOut}
          </Button>
        </form>
      </div>
    </>
  );
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const errorCode = first(params.error);
  const { root, principal } = await currentPrincipal();
  const idp = await root.auth.idp.current();
  const bootstrap = await root.auth.bootstrap.state();
  const instance = root.config.publicUrl.host;

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title={principal ? 'You are signed in' : `Sign in to ${instance}`}>
        {principal
          ? 'What you may do here is recomputed from your teams on every request.'
          : 'This gateway signs you in through the identity provider of your company. Nobody has a password here.'}
      </AuthHeading>

      {errorCode && isLoginErrorCode(errorCode) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Sign-in failed" testId="login-error">
            {LOGIN_ERROR_MESSAGES[errorCode]}
          </Callout>
        </div>
      )}

      {principal ? (
        <SignedIn principal={principal} />
      ) : idp ? (
        <form method="get" action="/auth/login" className={styles.act}>
          <input type="hidden" name="return_to" value="/login" />
          <Button type="submit" variant="primary" size="lg">
            Continue with {idp.settings.issuer.hostname}
          </Button>
        </form>
      ) : (
        <div className={styles.block}>
          <Callout
            tone="neutral"
            title="Sign-in is not set up yet"
            testId="login-not-configured"
            action={
              bootstrap.status === 'active' ? (
                <ButtonLink href="/admin/bootstrap" size="sm">
                  Set it up
                </ButtonLink>
              ) : undefined
            }
          >
            No identity provider is configured yet.{' '}
            {bootstrap.status === 'active'
              ? 'Whoever installed this gateway signs in once with the bootstrap token to connect it.'
              : 'Ask the administrator of this gateway.'}
          </Callout>
        </div>
      )}
    </AuthPage>
  );
}
