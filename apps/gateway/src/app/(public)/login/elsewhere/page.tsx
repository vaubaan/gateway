/**
 * `/login/elsewhere` — where a browser lands after Google, Microsoft or GitHub when it is
 * not the window that started the sign-in (ADR local-instance-carries-installed-oauth-clients):
 * the desktop app opens the consent in the default browser, and its own window finishes
 * signing in. This page only says so, and what happened (`outcome`: `done`, an error
 * code of the sign-in, `pending` or `expired`). It signs nobody in.
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Callout } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { isLoginErrorCode, LOGIN_ERROR_MESSAGES } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignedInElsewherePage({ searchParams }: Props) {
  const params = await searchParams;
  const raw = params.outcome;
  const outcome = (Array.isArray(raw) ? raw[0] : raw) ?? 'expired';
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const failed = isLoginErrorCode(outcome) ? LOGIN_ERROR_MESSAGES[outcome] : null;

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      {outcome === 'done' ? (
        <AuthHeading title="Go back to Vaubaan">
          You can close this tab: the Vaubaan window finishes signing you in.
        </AuthHeading>
      ) : failed ? (
        <>
          <AuthHeading title="Sign-in failed">Go back to Vaubaan to start again.</AuthHeading>
          <div className={styles.block}>
            <Callout tone="bad" title="What happened" testId="elsewhere-failed">
              {failed}
            </Callout>
          </div>
        </>
      ) : (
        <AuthHeading title="This sign-in is over">
          It expired or was already used. Go back to Vaubaan and start again.
        </AuthHeading>
      )}
    </AuthPage>
  );
}
