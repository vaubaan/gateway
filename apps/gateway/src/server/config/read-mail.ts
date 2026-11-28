/**
 * `mail.*` (ADR local-accounts-sign-in-provider, D6): the relay through which the
 * instance sends its own mail.
 */
import type { Reader } from './reader';
import { envNamesFor, keySpec } from './sources';
import { isMailTlsMode, MAIL_TLS_MODES, type MailConfig } from './types';

/**
 * `mail.*`: the whole block or none of it. A host without a sender (or the reverse)
 * is an incomplete relay and refused by name; a user without a password likewise.
 */
export function readMail(r: Reader): MailConfig | null {
  const host = r.string('mail.smtp_host')?.trim() || undefined;
  const from = r.string('mail.from')?.trim() || undefined;
  const user = r.string('mail.smtp_user')?.trim() || undefined;
  const password = r.string('mail.smtp_password') || undefined;
  const anySet =
    host !== undefined || from !== undefined || user !== undefined || password !== undefined;
  if (!anySet) return null;
  if (!host)
    r.issues.add(
      'mail.smtp_host',
      'required with the other mail.* keys',
      envNamesFor('mail.smtp_host'),
    );
  if (!from)
    r.issues.add(
      'mail.from',
      'required with the other mail.* keys: the sender address',
      envNamesFor('mail.from'),
    );
  if ((user === undefined) !== (password === undefined)) {
    r.issues.add(
      'mail.smtp_user',
      'set the user and the password together, or neither (a relay that takes mail without authentication)',
      [...envNamesFor('mail.smtp_user'), ...envNamesFor('mail.smtp_password')],
    );
  }
  if (from && !/^[^<>@\s]+@[^<>@\s]+$/.test(from) && !/^.+<[^<>@\s]+@[^<>@\s]+>$/.test(from)) {
    r.issues.add('mail.from', 'expected an address, or "Name <address>"', envNamesFor('mail.from'));
  }
  const port = r.int(keySpec('mail.smtp_port'));
  const tlsSpec = keySpec('mail.tls');
  const tls =
    r.string('mail.tls', { fallback: String(tlsSpec.default) }) ?? String(tlsSpec.default);
  if (!isMailTlsMode(tls)) {
    r.issues.add(
      'mail.tls',
      `expected one of ${MAIL_TLS_MODES.join(', ')}, got "${tls}"`,
      envNamesFor('mail.tls'),
    );
  }
  if (!host || !from || !isMailTlsMode(tls)) return null;
  return {
    smtpHost: host,
    smtpPort: port,
    smtpUser: user ?? null,
    smtpPassword: password ?? null,
    from,
    tls,
  };
}
