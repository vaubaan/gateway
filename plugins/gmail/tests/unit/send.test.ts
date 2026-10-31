/**
 * Sending over SMTP : `send_message` and `send_draft`, classified by the zone
 * of the worst recipient into the four `gmail.send-to-zone-*` risks, executed
 * against `fakeGmail()` and `fakeSmtp()`. A refused send reaches neither
 * transport ; the sent copy is Gmail's to file (nothing is appended) ; Bcc
 * travels in the envelope only. The nodemailer transport is driven through a
 * fake client. No network.
 */
import { describe, expect, test } from 'vitest';

import {
  serializeSlice,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import { palierOf, parseSlice, risksTouchedBy } from '@vaubaan/policy-engine';

import {
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GmailSmtpError,
  classifyGmail,
  createGmailPlugin,
  createNodemailerSmtpTransport,
  gmailCatalog,
  smtpError,
  withoutBccHeader,
  type SmtpClient,
  type SmtpClientOptions,
} from '../../src/index.ts';
import {
  DRAFTS,
  fakeGmail,
  fakeSmtp,
  message,
  type FakeGmail,
  type FakeSmtp,
} from './fake-imap.ts';

const MAILBOX = 'me@myorg.com';
const PASSWORD = 'abcdefghijklmnop';
const mailbox: Resource = {
  provider: 'gmail',
  ref: MAILBOX,
  displayName: MAILBOX,
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: [],
    account_email: MAILBOX,
  },
};
const account = { email: MAILBOX, appPassword: PASSWORD };

const ctx = (): ExecuteContext => ({
  credential: {
    kind: 'api-key',
    fields: { email: MAILBOX, app_password: 'abcd efgh ijkl mnop' },
    metadata: {},
  },
  fetch: mockFetch([]),
  resources: [mailbox],
});

const NOW = new Date('2026-10-31T09:30:00.000Z');
const DRAFT = '18c2a9f0e1d2b3c1';
const dec = (hex: string) => BigInt(`0x${hex}`).toString();

async function run(
  imap: FakeGmail,
  smtp: FakeSmtp,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  return createGmailPlugin({ transport: imap, smtp, now: () => NOW }).execute(ctx(), tool, args);
}
const body = (r: McpToolResult) => r.structuredContent as Record<string, unknown>;

/** The risk of the one slice a send emits. */
function riskOf(tool: string, args: Record<string, unknown>): string[] {
  const out = classifyGmail(tool, args, [mailbox]);
  if ('denied' in out) throw new Error(out.denied);
  expect(out.slices).toHaveLength(1);
  return risksTouchedBy(out.slices[0]!, gmailCatalog.indexed);
}

describe('classify : a send is priced by its worst recipient', () => {
  test.each([
    [[MAILBOX], 'gmail.send-to-zone-self', 'self'],
    [['colleague@myorg.com', MAILBOX], 'gmail.send-to-zone-internal', 'internal'],
    [['partner@vendor.com', 'colleague@myorg.com'], 'gmail.send-to-zone-allowlist', 'allowlist'],
    [
      ['partner@vendor.com', 'stranger@evil.example'],
      'gmail.send-to-zone-external',
      'external-unbounded',
    ],
  ])('to %j → %s', (to, risk, zone) => {
    const args = { to, subject: 's', body: 'b' };
    const out = classifyGmail('gmail__send_message', args, [mailbox]);
    expect('slices' in out && out.slices.map(serializeSlice)).toEqual([
      `gmail.mailbox.send-zone[${zone}].W`,
    ]);
    expect(riskOf('gmail__send_message', args)).toEqual([risk]);
    expect(riskOf('gmail__send_draft', { id: DRAFT, to })).toEqual([risk]);
  });

  test('a Bcc recipient counts like any other', () => {
    expect(
      riskOf('gmail__send_message', {
        to: [MAILBOX],
        bcc: ['x@evil.example'],
        subject: 's',
        body: 'b',
      }),
    ).toEqual(['gmail.send-to-zone-external']);
  });

  test('no recipient, too many, one that does not parse, or a draft without id : denied', () => {
    const deny = (tool: string, args: Record<string, unknown>) =>
      expect(classifyGmail(tool, args, [mailbox])).toHaveProperty('denied');
    deny('gmail__send_message', { subject: 's', body: 'b' });
    deny('gmail__send_message', { to: [], subject: 's', body: 'b' });
    deny('gmail__send_message', {
      to: Array.from({ length: 101 }, (_, i) => `p${i}@myorg.com`),
      subject: 's',
      body: 'b',
    });
    deny('gmail__send_message', { to: ['a@myorg.com, b@evil.example'], subject: 's', body: 'b' });
    deny('gmail__send_draft', { to: [MAILBOX] });
    deny('gmail__send_draft', { id: 'XYZ', to: [MAILBOX] });
    deny('gmail__send_draft', { id: DRAFT });
  });
});

describe('catalog : the send risks, their paliers and the Send macro-action', () => {
  const entry = (id: string) => gmailCatalog.catalog.risks.find((r) => r.id === id)!;

  test('self 1, internal 3, allowlist and external 4', () => {
    expect(palierOf(entry('gmail.send-to-zone-self').vector)).toBe(1);
    expect(palierOf(entry('gmail.send-to-zone-internal').vector)).toBe(3);
    expect(palierOf(entry('gmail.send-to-zone-allowlist').vector)).toBe(4);
    expect(entry('gmail.send-to-zone-external').vector).toMatchObject({
      reversibility: 'irreversible',
      data: 'pii',
      visibility: 'public',
    });
    expect(palierOf(entry('gmail.send-to-zone-external').vector)).toBe(4);
  });

  test('the four belong to the Send macro-action', () => {
    const send = gmailCatalog.catalog.macro_actions?.find((m) => m.id === 'send');
    expect(send?.label).toBe('Send');
    expect(send?.entries.map((e) => e.risk_id)).toEqual([
      'gmail.send-to-zone-self',
      'gmail.send-to-zone-internal',
      'gmail.send-to-zone-allowlist',
      'gmail.send-to-zone-external',
    ]);
  });

  test('the fallback is never what a send lands on', () => {
    const sl = parseSlice('gmail.mailbox.send-zone[external-unbounded].W');
    expect(risksTouchedBy(sl, gmailCatalog.indexed)).toEqual(['gmail.send-to-zone-external']);
  });
});

describe('send_message', () => {
  test('relays over SMTP alone : no IMAP session, Bcc in the envelope only, nothing appended', async () => {
    const imap = fakeGmail();
    const smtp = fakeSmtp();
    const r = await run(imap, smtp, 'gmail__send_message', {
      to: ['Colleague <colleague@myorg.com>'],
      cc: 'partner@vendor.com',
      bcc: [MAILBOX],
      subject: 'Réunion',
      body: 'See you at 10.',
    });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({
      sent: true,
      accepted: ['colleague@myorg.com', 'partner@vendor.com', MAILBOX],
      rejected: [],
      sent_copy: 'filed in Sent by Gmail',
    });
    expect(imap.calls).toEqual([]);
    expect(smtp.sent).toHaveLength(1);
    const { mail, account: signedIn, options } = smtp.sent[0]!;
    expect(signedIn).toEqual(account);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(mail.from).toBe(MAILBOX);
    expect(mail.to).toEqual(['colleague@myorg.com', 'partner@vendor.com', MAILBOX]);
    const raw = String(mail.raw);
    expect(raw).toContain('From: me@myorg.com\r\n');
    expect(raw).toContain('To: colleague@myorg.com\r\n');
    expect(raw).toContain('Cc: partner@vendor.com\r\n');
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).toContain('Subject: =?UTF-8?B?');
  });

  test('a duplicate recipient is relayed once', async () => {
    const smtp = fakeSmtp();
    await run(fakeGmail(), smtp, 'gmail__send_message', {
      to: [MAILBOX],
      cc: ['Me <ME@myorg.com>'],
      subject: 's',
      body: 'b',
    });
    expect(smtp.sent[0]!.mail.to).toEqual([MAILBOX]);
  });

  test.each([
    [{ subject: 's', body: 'b' }],
    [{ to: [MAILBOX], subject: 'a\r\nBcc: x@evil.example', body: 'b' }],
    [{ to: [MAILBOX], subject: 's' }],
    [{ to: ['not an address'], subject: 's', body: 'b' }],
    [{ to: Array.from({ length: 101 }, (_, i) => `p${i}@myorg.com`), subject: 's', body: 'b' }],
  ])('refused before any connection : %j', async (args) => {
    const imap = fakeGmail();
    const smtp = fakeSmtp();
    const r = await run(imap, smtp, 'gmail__send_message', args);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe('invalid_argument');
    expect(imap.calls).toEqual([]);
    expect(smtp.sent).toEqual([]);
  });

  test('a refused recipient is reported ; a refused send becomes a tool error', async () => {
    const smtp = fakeSmtp();
    smtp.rejecting = ['partner@vendor.com'];
    const partial = await run(fakeGmail(), smtp, 'gmail__send_message', {
      to: [MAILBOX, 'partner@vendor.com'],
      subject: 's',
      body: 'b',
    });
    expect(body(partial)).toMatchObject({ accepted: [MAILBOX], rejected: ['partner@vendor.com'] });

    smtp.failWith = new GmailSmtpError('smtp_sign_in_refused', 'Gmail refused the SMTP sign-in.');
    const refused = await run(fakeGmail(), smtp, 'gmail__send_message', {
      to: [MAILBOX],
      subject: 's',
      body: 'b',
    });
    expect(refused.isError).toBe(true);
    expect(body(refused).error).toBe('smtp_sign_in_refused');
  });
});

/** A draft the owner wrote in Gmail, with a Bcc header and an attachment-like body. */
function withDraft(): FakeGmail {
  const raw = [
    'From: me@myorg.com',
    'To: colleague@myorg.com',
    'Bcc: partner@vendor.com,',
    ' hidden@myorg.com',
    'Subject: Q3',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Bcc: this line is the body, kept.',
    '',
  ].join('\r\n');
  return fakeGmail([
    message({
      messageId: dec(DRAFT),
      threadId: dec('18c2a9f0e1d2b3c0'),
      folder: DRAFTS,
      labels: [],
      flags: ['\\Draft', '\\Seen'],
      subject: 'Q3',
      from: [{ name: null, address: MAILBOX }],
      to: [{ name: 'Colleague', address: 'Colleague@myorg.com' }],
      bcc: [
        { name: null, address: 'partner@vendor.com' },
        { name: null, address: 'hidden@myorg.com' },
      ],
      raw,
    }),
  ]);
}

const DECLARED = {
  id: DRAFT,
  to: ['colleague@myorg.com'],
  bcc: ['hidden@myorg.com', 'Partner <partner@vendor.com>'],
};

describe('send_draft', () => {
  test('list_drafts shows the Bcc recipients a send_draft must declare', async () => {
    const r = await run(withDraft(), fakeSmtp(), 'gmail__list_drafts', {});
    expect((body(r).drafts as Record<string, unknown>[])[0]).toMatchObject({
      id: DRAFT,
      to: ['Colleague <Colleague@myorg.com>'],
      bcc: ['partner@vendor.com', 'hidden@myorg.com'],
    });
  });

  test('relays the draft as stored, without its Bcc header, then removes it from Drafts', async () => {
    const imap = withDraft();
    const smtp = fakeSmtp();
    const r = await run(imap, smtp, 'gmail__send_draft', DECLARED);
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({ sent: true, draft_id: DRAFT, draft_removed: true });
    expect(imap.ops()).toEqual(['mailboxes', 'search', 'fetch', 'source', 'remove']);
    // Gmail files the sent copy itself : nothing is appended anywhere.
    expect(imap.calls.some((c) => c.op === 'append')).toBe(false);
    expect(imap.messages).toEqual([]);
    const { mail } = smtp.sent[0]!;
    expect(mail.from).toBe(MAILBOX);
    expect(mail.to).toEqual(['colleague@myorg.com', 'hidden@myorg.com', 'partner@vendor.com']);
    const raw = Buffer.isBuffer(mail.raw) ? mail.raw.toString('utf8') : mail.raw;
    expect(raw).toBe(
      [
        'From: me@myorg.com',
        'To: colleague@myorg.com',
        'Subject: Q3',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Bcc: this line is the body, kept.',
        '',
      ].join('\r\n'),
    );
  });

  test.each([
    [{ ...DECLARED, bcc: ['hidden@myorg.com'] }, 'bcc'],
    [{ ...DECLARED, to: ['colleague@myorg.com', MAILBOX] }, 'to'],
    [{ ...DECLARED, cc: [MAILBOX] }, 'cc'],
  ])(
    'recipients other than the draft holds : refused, unsent, the draft kept (%j)',
    async (args, field) => {
      const imap = withDraft();
      const smtp = fakeSmtp();
      const r = await run(imap, smtp, 'gmail__send_draft', args);
      expect(r.isError).toBe(true);
      expect(body(r).error).toBe('recipients_mismatch');
      expect(String(body(r).message)).toContain(`addressed ${field}:`);
      expect(smtp.sent).toEqual([]);
      expect(imap.ops()).not.toContain('remove');
      expect(imap.messages).toHaveLength(1);
    },
  );

  test('a draft that is not there, or too large, is not sent', async () => {
    const smtp = fakeSmtp();
    const missing = await run(withDraft(), smtp, 'gmail__send_draft', {
      ...DECLARED,
      id: '18c2a9f0e1d2b3ff',
    });
    expect(body(missing).error).toBe('not_found');

    const big = withDraft();
    big.messages[0]!.raw = 'x'.repeat(7 * 1024 * 1024 + 1);
    const tooLarge = await run(big, smtp, 'gmail__send_draft', DECLARED);
    expect(body(tooLarge).error).toBe('too_large');
    expect(smtp.sent).toEqual([]);
  });

  test('refused before any connection when an argument is wrong', async () => {
    for (const args of [{ to: [MAILBOX] }, { id: DRAFT }, { id: DRAFT, to: 'a@b' }]) {
      const imap = withDraft();
      const smtp = fakeSmtp();
      const r = await run(imap, smtp, 'gmail__send_draft', args);
      expect(r.isError).toBe(true);
      expect(imap.calls).toEqual([]);
      expect(smtp.sent).toEqual([]);
    }
  });

  test('a failed send leaves the draft in Drafts', async () => {
    const imap = withDraft();
    const smtp = fakeSmtp();
    smtp.failWith = new GmailSmtpError('smtp_unavailable', 'smtp.gmail.com could not be reached.');
    const r = await run(imap, smtp, 'gmail__send_draft', DECLARED);
    expect(body(r).error).toBe('smtp_unavailable');
    expect(imap.ops()).not.toContain('remove');
    expect(imap.messages).toHaveLength(1);
  });
});

describe('withoutBccHeader', () => {
  test('removes every Bcc field and its folded lines, in any case, and leaves the body', () => {
    const src =
      'BCC: a@x.example\nX-A: 1\nbcc :b@x.example,\n\tc@x.example\nTo: d@x.example\n\nBcc: body\n';
    expect(withoutBccHeader(Buffer.from(src, 'latin1')).toString('latin1')).toBe(
      'X-A: 1\nTo: d@x.example\n\nBcc: body\n',
    );
  });

  test('leaves the bytes of a message without one untouched', () => {
    const src = Buffer.from([
      0x54, 0x6f, 0x3a, 0x20, 0x61, 0x0d, 0x0a, 0x0d, 0x0a, 0xc3, 0xa9, 0xff,
    ]);
    expect(withoutBccHeader(src).equals(src)).toBe(true);
  });
});

describe('the nodemailer transport', () => {
  function fakeClient(result: Promise<{ accepted?: unknown[]; rejected?: unknown[] }>) {
    const seen: { options: SmtpClientOptions | null; sent: unknown[]; closed: number } = {
      options: null,
      sent: [],
      closed: 0,
    };
    const factory = (options: SmtpClientOptions): SmtpClient => {
      seen.options = options;
      return {
        sendMail: async (m) => {
          seen.sent.push(m);
          return result;
        },
        close: () => {
          seen.closed += 1;
        },
      };
    };
    return { seen, factory };
  }

  test('implicit TLS on smtp.gmail.com:465 with the app password, one client per send, closed', async () => {
    const { seen, factory } = fakeClient(
      Promise.resolve({ accepted: [{ address: MAILBOX, name: 'Me' }], rejected: ['x@y.example'] }),
    );
    const receipt = await createNodemailerSmtpTransport(factory).send(
      account,
      { timeoutMs: 60_000 },
      { from: MAILBOX, to: [MAILBOX, 'x@y.example'], raw: 'To: me@myorg.com\r\n\r\nhi\r\n' },
    );
    expect(receipt).toEqual({ accepted: [MAILBOX], rejected: ['x@y.example'] });
    expect(seen.options).toMatchObject({
      host: GMAIL_SMTP_HOST,
      port: GMAIL_SMTP_PORT,
      secure: true,
      auth: { user: MAILBOX, pass: PASSWORD },
    });
    expect(GMAIL_SMTP_HOST).toBe('smtp.gmail.com');
    expect(GMAIL_SMTP_PORT).toBe(465);
    expect(seen.sent).toEqual([
      {
        envelope: { from: MAILBOX, to: [MAILBOX, 'x@y.example'] },
        raw: 'To: me@myorg.com\r\n\r\nhi\r\n',
      },
    ]);
    expect(seen.closed).toBeGreaterThan(0);
  });

  test('a refusal is a GmailSmtpError ; the log holds its class and code, no address, password or message', async () => {
    const err = Object.assign(
      new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
      {
        code: 'EAUTH',
        response: '535-5.7.8 Username and Password not accepted',
      },
    );
    const { factory } = fakeClient(Promise.reject(err));
    const logged: unknown[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (...a: unknown[]) => logged.push(a),
      error: () => undefined,
    };
    await expect(
      createNodemailerSmtpTransport(factory).send(
        account,
        { timeoutMs: 60_000, logger },
        { from: MAILBOX, to: [MAILBOX], raw: 'Subject: secret plans\r\n\r\nbody\r\n' },
      ),
    ).rejects.toMatchObject({ name: 'GmailSmtpError', code: 'smtp_sign_in_refused' });
    const text = JSON.stringify(logged);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(MAILBOX);
    expect(text).not.toContain('secret plans');
    expect(text).toContain('smtp_sign_in_refused');
  });

  test('an aborted call opens no client', async () => {
    const { seen, factory } = fakeClient(Promise.resolve({}));
    const controller = new AbortController();
    controller.abort();
    await expect(
      createNodemailerSmtpTransport(factory).send(
        account,
        { timeoutMs: 60_000, signal: controller.signal },
        { from: MAILBOX, to: [MAILBOX], raw: 'x' },
      ),
    ).rejects.toBeInstanceOf(GmailSmtpError);
    expect(seen.options).toBeNull();
  });

  test('error codes map to the plugin’s words', () => {
    const code = (c: string) => smtpError(Object.assign(new Error('x'), { code: c }), account).code;
    expect(code('EAUTH')).toBe('smtp_sign_in_refused');
    expect(code('EENVELOPE')).toBe('recipients_refused');
    expect(code('ETIMEDOUT')).toBe('smtp_unavailable');
    expect(code('ECONNECTION')).toBe('smtp_unavailable');
    expect(code('EMESSAGE')).toBe('smtp_failed');
    expect(smtpError(new Error('x'), account).message).not.toContain(PASSWORD);
  });
});
