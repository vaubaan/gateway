/**
 * The second factor's forms (ADR local-accounts-sign-in-provider): the code
 * asked at sign-in, and the enrolment — a QR code the authenticator app scans
 * (rendered as an SVG data URL, nothing fetched), the secret to type by hand
 * (shown in groups of four, copied without the spaces),
 * and the first code that confirms it. Used outside the shell at sign-in and
 * inside it on Settings → Security.
 */
import { renderSVG } from 'uqr';

import styles from '@/components/auth/auth.module.css';
import { Button, CodeBlock, Field, Input } from '@/components/ui';

export function SecondFactorCodeForm({
  action,
  submitLabel,
  withRecovery,
  cancel,
}: {
  action: string;
  submitLabel: string;
  /** The field also takes a recovery code, and the hint says so. */
  withRecovery: boolean;
  cancel?: React.ReactNode;
}) {
  return (
    <form method="post" action={action} className={styles.field} data-testid="second-factor-form">
      <Field
        label={withRecovery ? 'Code' : 'The code the app shows now'}
        htmlFor="second-factor-code"
        shape={withRecovery ? '6 digits, or a recovery code' : '6 digits'}
        hint={
          withRecovery
            ? 'The six digits of your authenticator app; or one of your recovery codes, which works once.'
            : undefined
        }
      >
        <Input
          id="second-factor-code"
          name="code"
          inputMode={withRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoFocus
          required
          mono
        />
      </Field>
      <div className={styles.act}>
        <Button type="submit" variant="primary" size="lg">
          {submitLabel}
        </Button>
        {cancel}
      </div>
    </form>
  );
}

/** The QR code of an `otpauth://` URL, as an inline image. */
export function OtpauthQr({ otpauth }: { otpauth: string }) {
  const svg = renderSVG(otpauth, { border: 1 });
  return (
    <img
      className={styles.qr}
      alt="QR code to scan with an authenticator app"
      width={200}
      height={200}
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
      data-testid="otpauth-qr"
    />
  );
}

export function EnrolSecondFactor({
  otpauth,
  secret,
  action,
  cancel,
}: {
  otpauth: string;
  secret: string;
  action: string;
  cancel?: React.ReactNode;
}) {
  return (
    <>
      <div className={styles.block}>
        <OtpauthQr otpauth={otpauth} />
        <p className={styles.sentence}>
          Scan it with an authenticator app (Aegis, Google Authenticator, 1Password, Bitwarden…), or
          type the secret below into the app by hand.
        </p>
        <CodeBlock label="Secret, to type by hand" copy={secret} wrap testId="totp-secret">
          {secret.match(/.{1,4}/g)?.join(' ') ?? secret}
        </CodeBlock>
      </div>
      <SecondFactorCodeForm
        action={action}
        submitLabel="Confirm"
        withRecovery={false}
        cancel={cancel}
      />
    </>
  );
}
