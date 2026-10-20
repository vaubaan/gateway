/**
 * `/settings/security` — a person's own second factor, whatever their sign-in
 * provider (ADR administrators-live-in-the-instance, §7), and the password of a
 * local account (ADR local-accounts-sign-in-provider). The recovery codes of a new
 * second factor arrive here as a one-time notice.
 */
import { headers } from 'next/headers';

import { EnrolSecondFactor } from '@/components/auth/SecondFactorForms';
import { NoticeBanner } from '@/components/connections/parts';
import styles from '@/components/settings/settings.module.css';
import { SettingsFrame } from '@/components/shell/AppShell';
import {
  Button,
  ButtonLink,
  ConfirmSubmit,
  Field,
  Input,
  PageHeader,
  Row,
  Rows,
  Section,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { ENROL_PARAM, localAccountIdOf, safeReturnTo, SECURITY_PAGE } from '@/server/auth';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';
import { otpauthUrl } from '@/server/crypto/totp';

export const dynamic = 'force-dynamic';

export default async function SecurityPage({ searchParams }: { searchParams: PageSearchParams }) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { root, principal } = session;
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const providers = await root.auth.providers.views();
  const local = providers.find((p) => p.kind === 'local') ?? null;
  const accountId = local ? localAccountIdOf(principal, local) : null;
  const account = accountId ? await root.auth.accounts.accountById(accountId) : null;
  const hasFactor = await root.auth.secondFactors.has(principal.user.id);
  const codesLeft = hasFactor
    ? await root.auth.secondFactors.recoveryCodesLeft(principal.user.id)
    : 0;
  const providerName =
    providers.find((p) => p.id === principal.providerId)?.name ?? 'your sign-in provider';
  const enrolling = params[ENROL_PARAM] !== undefined;
  const step = enrolling ? await root.auth.sessions.peekLocalStep(await headers()) : null;
  const enrolment =
    step?.step === 'enrol' && step.userId === principal.user.id && step.totpSecret
      ? {
          secret: step.totpSecret,
          otpauth: otpauthUrl({
            issuer: (await root.instance.name.identity()).label,
            account: principal.user.email,
            secret: step.totpSecret,
          }),
        }
      : null;
  const administrator = principal.isOperator;
  // After an enrolment at sign-in: where the sign-in was going, once the codes are kept.
  const rawNext = typeof params.return_to === 'string' ? params.return_to : null;
  const next = rawNext ? safeReturnTo(rawNext, root.config.publicUrl, '') : '';

  return (
    <SettingsFrame principal={principal}>
      <PageHeader
        title="Security"
        lede={
          account
            ? 'Your password and your second factor, for the account this gateway keeps for you.'
            : `Your second factor on this gateway. Your password stays with ${providerName}.`
        }
      />
      <NoticeBanner notice={notice} />
      {next && (
        <Section first testId="continue-after-enrolment">
          <ButtonLink href={next} variant="primary" external>
            I kept the recovery codes — continue
          </ButtonLink>
        </Section>
      )}
      <>
        <Section
          title="Second factor"
          note="A code from an authenticator app at each sign-in, asked by this gateway whatever provider you sign in through."
          first
          testId="second-factor"
        >
          {enrolment ? (
            <EnrolSecondFactor
              otpauth={enrolment.otpauth}
              secret={enrolment.secret}
              action={`${SECURITY_PAGE}/second-factor/confirm`}
            />
          ) : (
            <Rows>
              <Row
                title={
                  hasFactor
                    ? 'Set up'
                    : administrator
                      ? 'Not set up — your next sign-in asks for it'
                      : 'Not set up'
                }
                description={
                  hasFactor
                    ? `${codesLeft} recovery codes left. Replacing it shows new ones.`
                    : 'Recommended: without it, whoever holds your sign-in opens every account this gateway holds for you.'
                }
                end={
                  <form method="post" action={`${SECURITY_PAGE}/second-factor/begin`}>
                    <Button type="submit" size="sm" data-testid="begin-second-factor">
                      {hasFactor ? 'Replace' : 'Set up'}
                    </Button>
                  </form>
                }
              />
              {hasFactor && !administrator && (
                <Row
                  title="Remove the second factor"
                  description="Within ten minutes of signing in. Your next sign-in asks for one again, unless your provider's own stands in for it."
                  end={
                    <ConfirmSubmit
                      action={`${SECURITY_PAGE}/second-factor/remove`}
                      label="Remove"
                      variant="danger"
                      tone="danger"
                      title="Remove your second factor?"
                      consequence="Your authenticator app and recovery codes stop working here."
                      confirmLabel="Remove"
                      testId="remove-second-factor"
                    />
                  }
                />
              )}
            </Rows>
          )}
        </Section>
        {account && (
          <Section title="Password" testId="password">
            <form method="post" action={`${SECURITY_PAGE}/password`} className={styles.form}>
              <Field label="Current password" htmlFor="current-password">
                <Input
                  id="current-password"
                  name="current_password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field
                label="New password"
                htmlFor="new-password"
                shape={`${PASSWORD_MIN_LENGTH} characters or more`}
              >
                <Input
                  id="new-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  required
                />
              </Field>
              <Field label="The same password again" htmlFor="new-password-again">
                <Input
                  id="new-password-again"
                  name="password_again"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  required
                />
              </Field>
              <div className={styles.formActions}>
                <Button type="submit" variant="primary">
                  Change the password
                </Button>
              </div>
            </form>
          </Section>
        )}
      </>
    </SettingsFrame>
  );
}
