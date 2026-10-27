/**
 * Mail delivery (spec §4.3 "mail delivery"; ADR local-accounts-sign-in-provider,
 * D6): the instance sends its own mail through the SMTP relay of `mail.*` —
 * today the two links of the local accounts, an invitation to create one and a
 * password reset. Nothing else of the gateway sends mail.
 *
 * `nodemailer` speaks SMTP (STARTTLS on a submission port, TLS from the first
 * byte, or clear text for a relay on the same host); a test hands in its own
 * `transport`. A failed send is logged without the recipient or the link; the
 * caller decides what to tell (handbook authentication).
 */
import nodemailer from 'nodemailer';

import type { LinkMailer } from '../auth/local-handlers';
import type { MailConfig } from '../config/types';
import type { Logger } from '../logging';

/** The one thing a transport does, for the tests' sake. */
export interface MailTransport {
  sendMail(message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<unknown>;
}

export interface MailerDeps {
  readonly config: MailConfig;
  readonly logger: Logger;
  /** The name of the gateway, in the subject and the body. */
  readonly instanceLabel: string;
  readonly transport?: MailTransport;
}

export function createSmtpTransport(config: MailConfig): MailTransport {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.tls === 'implicit',
    ignoreTLS: config.tls === 'none',
    requireTLS: config.tls === 'starttls',
    ...(config.smtpUser !== null && config.smtpPassword !== null
      ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
      : {}),
  });
}

/** The two mails, in plain text: the link is the whole point, nothing to render. */
export function linkMail(input: {
  readonly kind: 'invite' | 'reset';
  readonly instanceLabel: string;
  readonly url: URL;
  readonly expiresAt: string;
}): { subject: string; text: string } {
  const when = new Date(input.expiresAt).toUTCString();
  if (input.kind === 'invite') {
    return {
      subject: `Your account on ${input.instanceLabel}`,
      text: [
        `You are invited to ${input.instanceLabel}.`,
        '',
        'Open this link to choose your password and create your account:',
        input.url.href,
        '',
        `The link works once, until ${when}. If it has expired, ask an administrator for another one.`,
        'If you did not expect this mail, ignore it: nothing happens without the link.',
      ].join('\n'),
    };
  }
  return {
    subject: `Password reset on ${input.instanceLabel}`,
    text: [
      `Someone asked to reset the password of your account on ${input.instanceLabel}.`,
      '',
      'Open this link to choose a new password:',
      input.url.href,
      '',
      `The link works once, until ${when}.`,
      'If you did not ask for it, ignore this mail: your password stays as it is.',
    ].join('\n'),
  };
}

export function createLinkMailer(deps: MailerDeps): LinkMailer {
  const transport = deps.transport ?? createSmtpTransport(deps.config);
  const logger = deps.logger.child({ component: 'mail' });
  return {
    async sendLink(input) {
      const { subject, text } = linkMail({
        kind: input.kind,
        instanceLabel: deps.instanceLabel,
        url: input.url,
        expiresAt: input.expiresAt,
      });
      try {
        await transport.sendMail({ from: deps.config.from, to: input.to, subject, text });
        logger.info('mail sent', { kind: input.kind });
      } catch (err) {
        // Neither the address nor the link: the log is not where a link may land.
        logger.error('mail failed', { kind: input.kind, detail: describe(err) });
        // eslint-disable-next-line preserve-caught-error -- the cause is withheld on purpose: an SMTP error can quote the address.
        throw new Error(`mail delivery failed (${input.kind})`);
      }
    },
    async sendNotice(input) {
      try {
        await transport.sendMail({
          from: deps.config.from,
          to: input.to,
          subject: `${input.subject} — ${deps.instanceLabel}`,
          text: input.text,
        });
        logger.info('mail sent', { kind: 'notice' });
      } catch (err) {
        logger.error('mail failed', { kind: 'notice', detail: describe(err) });
        // eslint-disable-next-line preserve-caught-error -- the cause is withheld on purpose: an SMTP error can quote the address.
        throw new Error('mail delivery failed (notice)');
      }
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/https?:\/\/\S+/g, '<url>');
  return String(err);
}
