/**
 * `/login` — the entry of the interface: one button per sign-in provider (links
 * to `/auth/login/<id>`, carrying where to go after), the way to the bootstrap
 * page while the install token is valid, and the closed error codes of a failed
 * attempt.
 *
 * A person who is signed in has nothing to read here: the page sends them to
 * the home ("Now"), and the sign-in it starts returns there too. The card
 * "who is signed in" is kept for the two cases where the home is not the
 * answer: a failed attempt while a session exists (`?error=`), and the
 * install session of the bootstrap token, which owns nothing and has no home.
 *
 * It checks nothing itself: the session is the authenticator's, and what a
 * person may do is recomputed from their groups on every request.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { InstalledSignIn } from '@/components/auth/InstalledSignIn';
import { PasswordSignInForm } from '@/components/auth/PasswordForm';
import { isOperatorPrincipal } from '@/components/auth/principal';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Avatar, Button, ButtonLink, Callout, StatusMark } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { ACTIONS, ROLE_WORDS, ROUTES } from '@/lib/vocabulary';
import { setUpElsewhere } from '@/server/auth';
import {
  isLoginErrorCode,
  LOGIN_ERROR_MESSAGES,
  RESET_DONE_PARAM,
  safeReturnTo,
  signInStartPath,
  type Principal,
} from '@/server/auth';

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
  const failed = errorCode !== null && isLoginErrorCode(errorCode);
  // Signed in: the home, not a card about being signed in.
  if (principal?.kind === 'user' && !failed) redirect(ROUTES.home);
  // A sign-in provider switched off is not offered: the page never shows a button that does not work.
  const signInProviders = (await root.auth.signInProviders.views()).filter(
    (signInProvider) => signInProvider.enabled,
  );
  const local = signInProviders.find((signInProvider) => signInProvider.kind === 'local') ?? null;
  // Vaubaan's installed-app clients (local mode) start from the page, back on the loopback.
  const installed = signInProviders.filter(
    (signInProvider) => signInProvider.kind !== 'local' && signInProvider.source === 'installed',
  );
  const redirecting = signInProviders.filter(
    (signInProvider) => signInProvider.kind !== 'local' && signInProvider.source !== 'installed',
  );
  const resetDone = first(params[RESET_DONE_PARAM]) === 'done';
  const bootstrap = await root.auth.bootstrap.state();
  const instance = await root.instance.name.identity();
  // Where the sign-in lands: the address that sent the person here, else the home.
  const returnTo = safeReturnTo(first(params.return_to), root.config.publicUrl, ROUTES.home);

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title={principal ? 'You are signed in' : `Sign in to ${instance.label}`}>
        {principal
          ? principal.kind === 'user'
            ? 'The attempt below failed; the session you already had is still open.'
            : 'This session sets the gateway up; it is not a person’s.'
          : local && redirecting.length + installed.length > 0
            ? 'With your email address and password, or through a sign-in provider you already have an account at.'
            : local
              ? 'With the email address and the password of your account on this gateway.'
              : signInProviders.length > 1
                ? 'Choose how you sign in. Nobody has a password here.'
                : 'This gateway signs you in through a sign-in provider you already have an account at. Nobody has a password here.'}
      </AuthHeading>

      {resetDone && !principal && (
        <div className={styles.block}>
          <Callout tone="ok" title="Password changed" testId="reset-done">
            Sign in with the new password.
          </Callout>
        </div>
      )}

      {errorCode && isLoginErrorCode(errorCode) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Sign-in failed" testId="login-error">
            {LOGIN_ERROR_MESSAGES[errorCode]}
          </Callout>
        </div>
      )}

      {principal ? (
        <SignedIn principal={principal} />
      ) : signInProviders.length > 0 ? (
        <>
          {local && (
            <PasswordSignInForm
              action={`/auth/local/${encodeURIComponent(local.id)}`}
              returnTo={returnTo}
              heading={local.name}
            />
          )}
          {installed.length > 0 && (
            <InstalledSignIn
              providers={installed.map(({ id, name }) => ({ id, name }))}
              purpose="sign-in"
              returnTo={returnTo}
              primary={!local}
            />
          )}
          <div className={styles.act} data-testid="sign-in-providers">
            {redirecting.map((signInProvider, index) => {
              const elsewhere = setUpElsewhere(signInProvider, root.config.publicUrl);
              return (
                <div key={signInProvider.id} className={styles.act}>
                  <ButtonLink
                    href={`${signInStartPath(signInProvider.id)}?return_to=${encodeURIComponent(returnTo)}`}
                    variant={index === 0 && !local ? 'primary' : 'secondary'}
                    size="lg"
                    // A plain link: a prefetch of /auth/login would start a sign-in.
                    external
                  >
                    Continue with {signInProvider.name}
                  </ButtonLink>
                  {/* A restore on another host: the sign-in provider's callback is registered for the old one. */}
                  {elsewhere && (
                    <p
                      className={styles.muted}
                      data-testid={`set-up-elsewhere-${signInProvider.id}`}
                    >
                      {signInProvider.name} was set up for {elsewhere}. It signs you in here once an
                      administrator has registered this address at {signInProvider.name}
                      {local ? '; meanwhile, use your email address and password' : ''}.
                    </p>
                  )}
                </div>
              );
            })}
            {bootstrap.status === 'active' && (
              <Link href="/admin/bootstrap" data-testid="bootstrap-link">
                Set up this gateway with the install token
              </Link>
            )}
          </div>
        </>
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
