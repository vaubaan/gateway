/**
 * `/admin/bootstrap` — the first sign-in of whoever installs the gateway. It
 * accepts only the bootstrap token, only while it is active (spec §7.1).
 * Deliberately outside the guarded layout of Administration.
 *
 * In setup mode (the master key file is absent, a restore is configured, the
 * store is empty: `server/setup/`) the same address is the page that receives
 * the key file of the copy, with the bootstrap token; the normal boot follows.
 */
import { redirect } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import { BootstrapTokenInput } from '@/components/auth/BootstrapTokenInput';
import styles from '@/components/auth/auth.module.css';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, ButtonLink, Callout, Field, Input, Mono } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { instanceIdentity, instanceMetadata } from '@/lib/instance';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';
import {
  currentSetup,
  isSetupErrorCode,
  KEY_FIELD,
  SETUP_ERROR_MESSAGES,
  SETUP_ERROR_PARAM,
  SETUP_KEY_ACTION,
  TOKEN_FIELD,
  type SetupState,
} from '@/server/setup';

export const dynamic = 'force-dynamic';

export const generateMetadata = instanceMetadata;

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BootstrapPage({ searchParams }: Props) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : null;
  const setup = currentSetup();
  if (setup) return <SetupKeyPage setup={setup} error={params[SETUP_ERROR_PARAM]} />;
  const { root, principal } = await currentPrincipal();
  if (principal?.kind === 'bootstrap') redirect('/admin');
  const state = await root.auth.bootstrap.state();

  return (
    // Outside every layout: the page carries the build line itself.
    <AuthPage instance={await root.instance.name.identity()} footer={<BuildFooter />}>
      <AuthHeading title="Set up this gateway">
        Sign in once with the bootstrap token of the configuration to connect the identity provider
        of your company. The token stops working as soon as the first administrator signs in through
        that provider.
      </AuthHeading>

      {error && isLoginErrorCode(error) && (
        <div className={styles.block}>
          <Callout tone="bad" title="Refused" testId="bootstrap-error">
            {LOGIN_ERROR_MESSAGES[error]}
          </Callout>
        </div>
      )}

      {state.status === 'active' ? (
        <form method="post" action="/api/auth/bootstrap" className={styles.field}>
          <Field
            label="Bootstrap token"
            htmlFor="bootstrap-token"
            shape="32 characters or more"
            hint={
              <>
                The value of <Mono>VAUBAAN_BOOTSTRAP_TOKEN</Mono>, or of{' '}
                <Mono>bootstrap_token</Mono> in <Mono>gateway.yaml</Mono>; filled in when you opened
                a setup link that carries it.
              </>
            }
          >
            <BootstrapTokenInput id="bootstrap-token" name="token" />
          </Field>
          <div className={styles.act}>
            <Button type="submit" variant="primary" size="lg">
              Sign in to set up
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.block}>
          <Callout
            tone="neutral"
            title={
              state.status === 'revoked'
                ? 'The bootstrap token no longer works'
                : 'This gateway has no bootstrap token'
            }
            testId="bootstrap-closed"
            action={
              <ButtonLink href="/login" size="sm">
                Sign in
              </ButtonLink>
            }
          >
            {state.status === 'revoked' ? (
              <>
                It was revoked on <LocalDate ts={state.revokedAt} />, when the first administrator
                signed in.
              </>
            ) : (
              'The identity provider is set in its configuration.'
            )}{' '}
            Administrators now sign in through the identity provider.
          </Callout>
        </div>
      )}
    </AuthPage>
  );
}

/**
 * Setup mode: "Restore this gateway" — the bootstrap token and the key file
 * of the copy (the download of the former instance, or what `gen-master-key`
 * printed). The key is written to the configured path, the copy is verified
 * with it and restored, and the gateway then serves; a refused copy removes
 * the key again and says which check failed (never the source of the copy).
 */
async function SetupKeyPage({
  setup,
  error,
}: {
  setup: SetupState;
  error: string | string[] | undefined;
}) {
  const code = isSetupErrorCode(error) ? error : null;
  const tokenSet = setup.config.bootstrapToken !== null;
  return (
    <AuthPage instance={await instanceIdentity()} footer={<BuildFooter />}>
      <AuthHeading title="Restore this gateway">
        This gateway starts from a copy of another instance's store, and has no encryption key yet.
        Hand it the key the former instance handed you — the copy is checked with it before anything
        is kept — and sign in with the bootstrap token of the configuration.
      </AuthHeading>

      {code && (
        <div className={styles.block}>
          <Callout tone="bad" title="Not done" testId="setup-error">
            {SETUP_ERROR_MESSAGES[code]}
            {code === 'restore-refused' && setup.lastRefusal && (
              <>
                {' '}
                <Mono>{setup.lastRefusal.message}</Mono>
              </>
            )}
          </Callout>
        </div>
      )}

      {tokenSet ? (
        <form
          method="post"
          action={SETUP_KEY_ACTION}
          encType="multipart/form-data"
          className={styles.field}
          data-testid="setup-key-form"
        >
          <Field
            label="Bootstrap token"
            htmlFor="setup-token"
            shape="32 characters or more"
            hint={
              <>
                The value of <Mono>VAUBAAN_BOOTSTRAP_TOKEN</Mono>, or of{' '}
                <Mono>bootstrap_token</Mono> in <Mono>gateway.yaml</Mono>.
              </>
            }
          >
            <BootstrapTokenInput id="setup-token" name={TOKEN_FIELD} />
          </Field>
          <Field
            label="Encryption key file"
            htmlFor="setup-key"
            shape="32 bytes in base64, one line"
            hint={
              <>
                The file the former instance handed out (<Mono>vaubaan-master-key.txt</Mono>), or
                the output of <Mono>npm run gen-master-key</Mono> that it was started with. It is
                written to <Mono>{setup.masterKeyFile}</Mono> and never shown.
              </>
            }
          >
            <Input id="setup-key" type="file" name={KEY_FIELD} required accept=".txt,text/plain" />
          </Field>
          <div className={styles.act}>
            <Button type="submit" variant="primary" size="lg">
              Install the key and restore
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.block}>
          <Callout tone="bad" title="No bootstrap token" testId="setup-no-token">
            {SETUP_ERROR_MESSAGES['no-bootstrap-token']}
          </Callout>
        </div>
      )}
    </AuthPage>
  );
}
