/**
 * SMTP transport of the `gmail` provider : one connection per send to
 * `smtp.gmail.com:465` (implicit TLS), signed in with the same app password
 * as IMAP, through `nodemailer`.
 *
 * ADR  : docs/decisions/gmail-over-imap-with-an-app-password.md ;
 *        docs/decisions/provider-error-text-stays-with-the-agent.md.
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * The transport is an interface so `execute` is tested without a network :
 * `createGmailPlugin({ smtp })` takes a fake. Rules of the real one :
 *   - one send is one connection : no pool, closed once the message is sent ;
 *   - the message is a finished RFC 5322 text (`raw`) and the envelope is
 *     given apart : the recipients are the ones `execute` checked, never
 *     addresses read again from the headers ;
 *   - nothing is logged but the class of an error : never the password, an
 *     address or a line of the message ;
 *   - a refusal becomes a `GmailSmtpError` whose code the plugin wrote ; its
 *     message, which may quote Gmail, goes back to the calling agent only.
 *
 * Gmail files a copy of what it relays in the Sent folder itself : nothing
 * here, and nothing in `execute`, appends one.
 */

import { createTransport } from 'nodemailer';

import type { GmailAccount } from './credential.ts';
import type { GmailSessionOptions } from './transport.ts';

/** Gmail's SMTP submission server : implicit TLS on 465 (Google, "IMAP, POP and SMTP"). */
export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;

/** Budget of the TCP and TLS handshake. */
export const SMTP_CONNECT_TIMEOUT_MS = 10_000;
/** Budget of the server's greeting. */
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
/** Silence after which the socket is given up. */
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;

/** One message to relay : the envelope apart, the message as it will be delivered. */
export interface SmtpMail {
  /** `MAIL FROM` : the mailbox of the connection. */
  readonly from: string;
  /** `RCPT TO` : every recipient, Bcc included, each one bare `local@domain`. */
  readonly to: readonly string[];
  /** The RFC 5322 message, CRLF line endings, with no `Bcc` header. */
  readonly raw: string | Buffer;
}

/** What the server said about the recipients. */
export interface SmtpReceipt {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface GmailSmtpTransport {
  /** Signs in, relays one message, closes. Throws `GmailSmtpError` when Gmail refuses. */
  send(account: GmailAccount, options: GmailSessionOptions, mail: SmtpMail): Promise<SmtpReceipt>;
}

/** Why a send failed, in the plugin's words ; the message may quote Gmail (for the agent only). */
export type GmailSmtpErrorCode =
  'smtp_sign_in_refused' | 'recipients_refused' | 'smtp_unavailable' | 'smtp_failed';

export class GmailSmtpError extends Error {
  constructor(
    readonly code: GmailSmtpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GmailSmtpError';
  }
}

interface NodemailerError extends Error {
  readonly code?: string;
  readonly response?: string;
  readonly responseCode?: number;
}

/** A short, single-line rendering of the server's reply, for the agent. */
function serverWords(err: NodemailerError): string {
  const text = (err.response ?? '').replace(/[^\x20-\x7e]/g, ' ').trim();
  return text.length > 0 ? ` (${text.slice(0, 200)})` : '';
}

/** Nodemailer's error → the plugin's code and words. Exported for the tests. */
export function smtpError(err: unknown, account: GmailAccount): GmailSmtpError {
  if (err instanceof GmailSmtpError) return err;
  const e = (err ?? {}) as NodemailerError;
  switch (e.code) {
    case 'EAUTH':
      return new GmailSmtpError(
        'smtp_sign_in_refused',
        `Gmail refused the SMTP sign-in of ${account.email}${serverWords(e)}: the app password was revoked, or the Google Workspace administrator does not allow app passwords or SMTP for the account.`,
      );
    case 'EENVELOPE':
      return new GmailSmtpError(
        'recipients_refused',
        `Gmail refused the sender or every recipient${serverWords(e)}; nothing was sent.`,
      );
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ETLS':
      return new GmailSmtpError(
        'smtp_unavailable',
        `${GMAIL_SMTP_HOST} could not be reached or did not answer in time; the message may not have been sent.`,
      );
    default:
      return new GmailSmtpError(
        'smtp_failed',
        `Gmail did not take the message${serverWords(e)}; it may not have been sent.`,
      );
  }
}

/** The send was cut short by the caller's signal or by its deadline. */
class SmtpStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpStopped';
  }
}

/** The part of a nodemailer transporter this module uses ; tests pass a fake. */
export interface SmtpClient {
  sendMail(message: {
    readonly envelope: { readonly from: string; readonly to: string[] };
    readonly raw: string | Buffer;
  }): Promise<{ readonly accepted?: unknown[]; readonly rejected?: unknown[] }>;
  close(): void;
}

/** Options of the one client of a send. */
export interface SmtpClientOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: true;
  readonly auth: { readonly user: string; readonly pass: string };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
}

export type SmtpClientFactory = (options: SmtpClientOptions) => SmtpClient;

const nodemailerClient: SmtpClientFactory = (options) =>
  createTransport({
    ...options,
    auth: { ...options.auth },
    // No pool : one connection per send, closed with the transporter.
    pool: false,
    // Nothing of the SMTP dialogue, which carries the addresses and the message, reaches a log.
    logger: false,
    debug: false,
    transactionLog: false,
    // A raw message reads no file and no URL ; said explicitly anyway.
    disableFileAccess: true,
    disableUrlAccess: true,
  });

const addressesOf = (list: readonly unknown[] | undefined): string[] =>
  (list ?? [])
    .map((a) =>
      typeof a === 'string'
        ? a
        : typeof (a as { address?: unknown })?.address === 'string'
          ? (a as { address: string }).address
          : null,
    )
    .filter((a): a is string => a !== null);

/** The real transport over the given client factory : one client per send. */
export function createNodemailerSmtpTransport(
  newClient: SmtpClientFactory = nodemailerClient,
): GmailSmtpTransport {
  return {
    async send(account, options, mail) {
      if (options.signal?.aborted) {
        throw new GmailSmtpError(
          'smtp_failed',
          'the call was aborted by the gateway; nothing was sent.',
        );
      }
      const client = newClient({
        host: GMAIL_SMTP_HOST,
        port: GMAIL_SMTP_PORT,
        secure: true,
        auth: { user: account.email, pass: account.appPassword },
        connectionTimeout: Math.min(SMTP_CONNECT_TIMEOUT_MS, options.timeoutMs),
        greetingTimeout: Math.min(SMTP_GREETING_TIMEOUT_MS, options.timeoutMs),
        socketTimeout: Math.min(SMTP_SOCKET_TIMEOUT_MS, options.timeoutMs),
      });

      let stop: ((err: Error) => void) | null = null;
      const stopped = new Promise<never>((_resolve, reject) => {
        stop = reject;
      });
      stopped.catch(() => undefined);
      const end = (reason: string) => () => {
        stop?.(new SmtpStopped(reason));
        client.close();
      };
      const onAbort = end(
        'the call was aborted by the gateway; the message may not have been sent.',
      );
      const timer = setTimeout(
        end(
          `the SMTP send timed out after ${Math.round(options.timeoutMs / 1000)}s; the message may not have been sent.`,
        ),
        options.timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const info = await Promise.race([
          client.sendMail({ envelope: { from: mail.from, to: [...mail.to] }, raw: mail.raw }),
          stopped,
        ]);
        return { accepted: addressesOf(info.accepted), rejected: addressesOf(info.rejected) };
      } catch (err) {
        if (err instanceof SmtpStopped) throw new GmailSmtpError('smtp_unavailable', err.message);
        const refused = smtpError(err, account);
        options.logger?.warn('gmail smtp send failed', {
          error_class: err instanceof Error ? err.name : typeof err,
          code: refused.code,
        });
        throw refused;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        client.close();
      }
    },
  };
}

/** The real transport : one `nodemailer` connection per send. */
export const nodemailerSmtpTransport: GmailSmtpTransport = createNodemailerSmtpTransport();
