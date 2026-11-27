/**
 * `/welcome` — the setup of an instance in local mode (ADR
 * local-mode-for-an-instance-on-this-computer; spec §7.1): two screens instead of
 * Setup's checklist. First the key (download it, say it is kept), then the person's
 * email and password, which `POST /api/admin/setup/local` turns into the
 * administrator's sign-in account before ending the setup and signing them in — or their
 * Google, Microsoft or GitHub account, through the installed-app clients the build carries
 * (`InstalledSignIn`, purpose `setup`).
 * Only for the holder of the setup link while the setup is open; absent otherwise.
 */
import { notFound, redirect } from 'next/navigation';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { InstalledSignIn } from '@/components/auth/InstalledSignIn';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, Callout, Checkbox, Field, Input } from '@/components/ui';
import { takeNotice } from '@/lib/accounts/session';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';
import {
  CONFIRMED_FIELD,
  FROM_FIELD,
  KEY_PROBLEM_PARAM,
  MASTER_KEY_DOWNLOAD_ACTION,
  MASTER_KEY_HANDOVER_ACTION,
  type MasterKeyProblem,
} from '@/server/master-key';

export const dynamic = 'force-dynamic';

const LOCAL_SETUP_ACTION = '/api/admin/setup/local';

const KEY_PROBLEMS: Record<MasterKeyProblem, string> = {
  'not-confirmed': 'Tick the box once the key is in a safe place.',
  'sign-in-again': 'The setup was opened too long ago. Quit Vaubaan and open it again.',
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WelcomePage({ searchParams }: Props) {
  const { root, principal } = await currentPrincipal();
  if (!root.config.local) notFound();
  if ((await root.auth.bootstrap.state()).status !== 'active') redirect('/');
  if (principal?.kind !== 'bootstrap') redirect('/admin/bootstrap');
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const problemParam = params[KEY_PROBLEM_PARAM];
  const keyProblem =
    problemParam === 'not-confirmed' || problemParam === 'sign-in-again' ? problemParam : null;
  const { handoverPending } = await root.masterKey.service.state();
  // Google, Microsoft and GitHub through Vaubaan's installed-app clients, when this build
  // carries them (ADR local-instance-carries-installed-oauth-clients).
  const installed = (await root.auth.signInProviders.views())
    .filter((signInProvider) => signInProvider.source === 'installed')
    .map(({ id, name }) => ({ id, name }));
  const errorParam = params.error;
  const errorCode = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const flowFailed =
    errorCode !== undefined && isLoginErrorCode(errorCode) ? LOGIN_ERROR_MESSAGES[errorCode] : null;

  return (
    <AuthPage instance={await root.instance.name.identity()} footer={<BuildFooter />}>
      {handoverPending ? (
        <>
          <AuthHeading title="1 of 2 · Keep your encryption key">
            It opens a backup of your accounts if this computer is lost. Put the file in your
            password manager; you will not need it day to day.
          </AuthHeading>
          {keyProblem && (
            <div className={styles.block}>
              <Callout tone="bad" title="Not yet" testId="welcome-key-problem">
                {KEY_PROBLEMS[keyProblem]}
              </Callout>
            </div>
          )}
          <form method="post" action={MASTER_KEY_DOWNLOAD_ACTION} className={styles.act}>
            <input type="hidden" name={FROM_FIELD} value="welcome" readOnly />
            <Button type="submit" variant="secondary" data-testid="welcome-download">
              Download the key
            </Button>
          </form>
          <form method="post" action={MASTER_KEY_HANDOVER_ACTION} className={styles.field}>
            <input type="hidden" name={FROM_FIELD} value="welcome" readOnly />
            <Checkbox name={CONFIRMED_FIELD} required data-testid="welcome-key-kept">
              I put it in a safe place
            </Checkbox>
            <div className={styles.act}>
              <Button type="submit" variant="primary" size="lg" data-testid="welcome-continue">
                Continue
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <AuthHeading title="2 of 2 · Create your account">
            {installed.length > 0
              ? `With your ${installed.map((p) => p.name).join(', ')} account, or an email and a password.`
              : 'The email and the password you sign in to Vaubaan with.'}
          </AuthHeading>
          {flowFailed && (
            <div className={styles.block}>
              <Callout tone="bad" title="Not created" testId="welcome-flow-problem">
                {flowFailed}
              </Callout>
            </div>
          )}
          {installed.length > 0 && (
            <InstalledSignIn providers={installed} purpose="setup" returnTo="/" />
          )}
          {notice && (
            <div className={styles.block}>
              <Callout tone="bad" title={notice.title} testId="welcome-account-problem">
                {notice.lines.join(' ')}
              </Callout>
            </div>
          )}
          <form
            method="post"
            action={LOCAL_SETUP_ACTION}
            className={styles.field}
            data-testid="welcome-account-form"
          >
            <Field label="Email" htmlFor="welcome-email">
              <Input id="welcome-email" name="email" type="email" autoComplete="email" required />
            </Field>
            <Field
              label="Password"
              htmlFor="welcome-password"
              shape={`${PASSWORD_MIN_LENGTH} characters or more`}
            >
              <Input
                id="welcome-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </Field>
            <Field label="The same password again" htmlFor="welcome-password-again">
              <Input
                id="welcome-password-again"
                name="password_again"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </Field>
            <div className={styles.act}>
              <Button type="submit" variant="primary" size="lg" data-testid="welcome-create">
                Create my account
              </Button>
            </div>
          </form>
        </>
      )}
    </AuthPage>
  );
}
