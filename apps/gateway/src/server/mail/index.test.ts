import { describe, expect, it } from 'vitest';

import { createLogger } from '../logging';
import { createLinkMailer, linkMail, type MailTransport } from './index';

const CONFIG = {
  smtpHost: 'smtp.example.net',
  smtpPort: 587,
  smtpUser: 'relay',
  smtpPassword: 'relay-secret',
  from: 'Gateway <noreply@example.net>',
  tls: 'starttls' as const,
};

function logger(lines: string[]) {
  return createLogger({
    level: 'info',
    redact: (s) => s,
    write: (_level, line) => lines.push(line),
  });
}

describe('the mails of the sign-in accounts', () => {
  it('writes the two mails around the link, in plain text', () => {
    const url = new URL('https://gateway.example.com/sign-in-account/create?token=abc');
    const invite = linkMail({
      kind: 'invite',
      instanceLabel: 'Acme',
      url,
      expiresAt: '2026-10-19T10:15:00Z',
    });
    expect(invite.subject).toBe('Your account on Acme');
    expect(invite.text).toContain(url.href);
    expect(invite.text).toContain('works once');
    const reset = linkMail({
      kind: 'reset',
      instanceLabel: 'Acme',
      url,
      expiresAt: '2026-10-19T10:15:00Z',
    });
    expect(reset.subject).toBe('Password reset on Acme');
    expect(reset.text).toContain('ignore this mail');
  });

  it('sends through the transport with the configured sender; a failure names neither the address nor the link', async () => {
    const sent: unknown[] = [];
    const lines: string[] = [];
    const transport: MailTransport = {
      async sendMail(message) {
        sent.push(message);
        if (message.to === 'down@example.com')
          throw new Error(
            'relay refused https://gateway.example.com/sign-in-account/create?token=abc',
          );
      },
    };
    const mailer = createLinkMailer({
      config: CONFIG,
      logger: logger(lines),
      instanceLabel: 'Acme',
      transport,
    });
    await mailer.sendLink({
      kind: 'invite',
      to: 'ada@example.com',
      url: new URL('https://gateway.example.com/sign-in-account/create?token=abc'),
      expiresAt: '2026-10-19T10:15:00Z',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: CONFIG.from, to: 'ada@example.com' });
    await expect(
      mailer.sendLink({
        kind: 'reset',
        to: 'down@example.com',
        url: new URL('https://gateway.example.com/sign-in-account/reset?token=xyz'),
        expiresAt: '2026-10-19T10:15:00Z',
      }),
    ).rejects.toThrow('mail delivery failed');
    const log = lines.join('\n');
    expect(log).toContain('mail failed');
    expect(log).not.toContain('down@example.com');
    expect(log).not.toContain('token=');
  });
});
