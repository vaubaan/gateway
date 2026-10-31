/**
 * Execution of the Gmail tools over IMAP, against `fakeGmail()` : folders by
 * special use (localized names), ids as the hexadecimal of X-GM-THRID /
 * X-GM-MSGID, labels by name, drafts appended and never sent, and every
 * refusal before any connection. No network.
 */
import { describe, expect, test } from 'vitest';

import {
  jsonObjectsOf,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  buildDraft,
  createGmailPlugin,
  encodeHeaderValue,
  hexToImapId,
  imapIdToHex,
  textPartOf,
  userLabels,
} from '../../src/index.ts';
import { ALL, DRAFTS, FOLDERS, fakeGmail, message, type FakeGmail } from './fake-imap.ts';

const MAILBOX = 'me@myorg.com';
const mailbox: Resource = {
  provider: 'gmail',
  ref: MAILBOX,
  displayName: MAILBOX,
  metadata: { internal_domains: ['myorg.com'], account_email: MAILBOX, sensitive_labels: ['HR'] },
};

// Two threads : T1 (two messages), T2 (one).
const T1 = '18c2a9f0e1d2b3a4';
const T2 = '18c2a9f0e1d2b3b0';
const dec = (hex: string) => BigInt(`0x${hex}`).toString();
const M1 = '18c2a9f0e1d2b3a5';
const M2 = '18c2a9f0e1d2b3a6';
const M3 = '18c2a9f0e1d2b3b1';

function seeded(): FakeGmail {
  return fakeGmail([
    message({
      messageId: dec(M1),
      threadId: dec(T1),
      subject: 'Contract',
      text: 'First',
      matches: ['from:colleague@myorg.com'],
    }),
    message({
      messageId: dec(M2),
      threadId: dec(T1),
      subject: 'Re: Contract',
      text: 'Second '.repeat(5000),
      flags: [],
      labels: ['\\Inbox', '\\Important', 'Legal/Contracts'],
      matches: ['from:colleague@myorg.com'],
    }),
    message({
      messageId: dec(M3),
      threadId: dec(T2),
      subject: 'Lunch',
      matches: ['from:colleague@myorg.com'],
    }),
  ]);
}

const ctx = (resources: readonly Resource[] = [mailbox], email = MAILBOX): ExecuteContext => ({
  credential: {
    kind: 'api-key',
    fields: { email, app_password: 'abcd efgh ijkl mnop' },
    metadata: {},
  },
  fetch: mockFetch([]),
  resources,
});

const NOW = new Date('2026-10-24T09:30:00.000Z');

async function run(
  transport: FakeGmail,
  tool: string,
  args: Record<string, unknown>,
  context: ExecuteContext = ctx(),
): Promise<McpToolResult> {
  return createGmailPlugin({ transport, now: () => NOW }).execute(context, tool, args);
}

interface Listed {
  readonly id: string;
  readonly [key: string]: unknown;
}
interface Body {
  readonly error?: string;
  readonly message?: string;
  readonly threads: readonly Listed[];
  readonly messages: readonly (Listed & { readonly text: string })[];
  readonly drafts: readonly Listed[];
  readonly labels: readonly Listed[];
  readonly [key: string]: unknown;
}
/** The JSON a result's text carries : the answer, or a refusal's code and words. */
const body = (r: McpToolResult): Body => jsonObjectsOf(r)[0] as Body;

describe('ids : the Gmail API hexadecimal of IMAP’s decimal numbers', () => {
  test('round trip, 64 bits at most', () => {
    expect(imapIdToHex('1785309829081492900')).toBe('18c6b1d4a06a6da4');
    expect(hexToImapId('18c6b1d4a06a6da4')).toBe('1785309829081492900');
    expect(hexToImapId('ffffffffffffffff')).toBe('18446744073709551615');
  });
});

describe('search_threads', () => {
  test('X-GM-RAW in the \\All folder found by special use, grouped by thread, newest first', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__search_threads', { q: 'from:colleague@myorg.com' });
    expect(r.isError).toBeUndefined();
    expect(t.calls.find((c) => c.op === 'search')).toEqual({
      op: 'search',
      path: ALL,
      query: { gmailRaw: 'from:colleague@myorg.com' },
    });
    expect(body(r).threads.map((x) => x.id)).toEqual([T2, T1]);
    expect(body(r).threads[1]).toMatchObject({
      subject: 'Re: Contract',
      matching_messages: 2,
      labels: ['INBOX', 'IMPORTANT', 'Legal/Contracts', 'UNREAD'],
    });
    // Envelopes only : a search reads no body.
    expect(t.calls.filter((c) => c.op === 'fetch').every((c) => c.bodyBytes === null)).toBe(true);
  });

  test('max_results caps the threads ; out of range is refused before any connection', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__search_threads', {
      q: 'from:colleague@myorg.com',
      max_results: 1,
    });
    expect(body(r).threads).toHaveLength(1);
    const big = await run(t, 'gmail__search_threads', { q: 'x', max_results: 500 });
    expect(big.isError).toBeUndefined();
    for (const bad of [0, -1, 1.5, '10']) {
      const fresh = seeded();
      const refused = await run(fresh, 'gmail__search_threads', { q: 'x', max_results: bad });
      expect(refused.isError).toBe(true);
      expect(fresh.calls).toEqual([]);
    }
  });

  test('a mailbox whose All Mail is not shown in IMAP says which setting to change', async () => {
    const t = seeded();
    t.folders = FOLDERS.filter((f) => f.specialUse !== '\\All');
    const r = await run(t, 'gmail__search_threads', { q: 'x' });
    expect(r.isError).toBe(true);
    expect(body(r)).toMatchObject({ error: 'folder_not_found' });
    expect(body(r).message).toMatch(/Show in IMAP/);
  });
});

describe('get_thread', () => {
  test('every message of the thread with labels and a capped plain-text body', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__get_thread', { id: T1 });
    expect(t.calls.find((c) => c.op === 'search')).toMatchObject({ query: { threadId: dec(T1) } });
    expect(t.calls.find((c) => c.op === 'fetch')).toMatchObject({ bodyBytes: 20_000 });
    const messages = body(r).messages;
    expect(messages.map((m) => m.id)).toEqual([M1, M2]);
    expect(messages[0]).toMatchObject({
      thread_id: T1,
      subject: 'Contract',
      text: 'First',
      text_truncated: false,
      from: ['Colleague <colleague@myorg.com>'],
    });
    expect(messages[1]?.text).toHaveLength(20_000);
    expect(messages[1]?.text_truncated).toBe(true);
  });

  test('an unknown thread is not_found ; a malformed id opens no connection', async () => {
    const t = seeded();
    expect(body(await run(t, 'gmail__get_thread', { id: 'abc' }))).toMatchObject({
      error: 'not_found',
    });
    const fresh = seeded();
    const r = await run(fresh, 'gmail__get_thread', { id: 'FMfcgzQXJZsr' });
    expect(r.isError).toBe(true);
    expect(fresh.calls).toEqual([]);
  });
});

describe('results', () => {
  test('an answer is JSON text with its structured twin ; a refusal is the code and words as text, isError', async () => {
    const t = seeded();
    const answered = await run(t, 'gmail__list_labels', {});
    expect(answered.isError).toBeUndefined();
    expect(answered.structuredContent).toEqual(body(answered));
    const declined = await run(seeded(), 'gmail__get_thread', { id: 'abc' });
    expect(declined).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'not_found',
            message: 'gmail: no thread abc in All Mail.',
          }),
        },
      ],
      isError: true,
    });
  });
});

describe('list_drafts and create_draft', () => {
  test('create_draft appends to the \\Drafts folder with \\Draft, and never sends', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__create_draft', {
      to: ['Colleague <colleague@myorg.com>'],
      cc: 'me@myorg.com',
      subject: 'Réunion de lundi',
      body: 'Bonjour,\nà lundi.',
    });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({
      sent: false,
      draft: { id: expect.stringMatching(/^[0-9a-f]+$/) as unknown },
    });
    const append = t.calls.find((c) => c.op === 'append');
    if (!append || append.op !== 'append') throw new Error('expected an append');
    expect(append.path).toBe(DRAFTS);
    expect(append.flags).toEqual(['\\Draft', '\\Seen']);
    expect(append.message).toContain('From: me@myorg.com\r\n');
    // Display names are dropped : the address alone, as the classifier parsed it.
    expect(append.message).toContain('To: colleague@myorg.com\r\n');
    expect(append.message).toContain('Cc: me@myorg.com\r\n');
    expect(append.message).toContain(`Subject: ${encodeHeaderValue('Réunion de lundi')}\r\n`);
    expect(append.message).toContain('Content-Transfer-Encoding: base64');
    expect(t.ops()).not.toContain('store');
  });

  test('a subject with a line break is refused before any connection (no header injection)', async () => {
    for (const subject of ['hi\r\nBcc: evil@evil.example', 'hi\nX: y', 'tab\there', 'nul\u0000']) {
      const t = seeded();
      const r = await run(t, 'gmail__create_draft', {
        to: ['colleague@myorg.com'],
        subject,
        body: 'b',
      });
      expect(r.isError).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });

  test('a recipient that is not exactly one address is refused before any connection', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__create_draft', {
      to: ['colleague@myorg.com\r\nBcc: evil@evil.example'],
      subject: 's',
      body: 'b',
    });
    expect(r.isError).toBe(true);
    expect(t.calls).toEqual([]);
  });

  test('the body cannot end the headers : it is base64', () => {
    const raw = buildDraft({
      from: MAILBOX,
      to: [],
      cc: [],
      bcc: [],
      subject: 's',
      body: '\r\n\r\nBcc: evil@evil.example\r\n',
      date: NOW,
    });
    const [headers, encoded] = raw.split('\r\n\r\n');
    expect(headers).not.toContain('Bcc');
    expect(Buffer.from(encoded!.replace(/\r\n/g, ''), 'base64').toString()).toBe(
      '\r\n\r\nBcc: evil@evil.example\r\n',
    );
    expect(raw).toContain('Date: Sat, 24 Oct 2026 09:30:00 +0000');
  });

  test('a long non-ASCII subject is folded into encoded words', () => {
    const encoded = encodeHeaderValue('é'.repeat(60));
    for (const word of encoded.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(encodeHeaderValue('plain')).toBe('plain');
  });

  test('list_drafts reads the \\Drafts folder found by special use', async () => {
    const t = seeded();
    await run(t, 'gmail__create_draft', { to: ['colleague@myorg.com'], subject: 's', body: 'b' });
    const r = await run(t, 'gmail__list_drafts', {});
    expect(t.calls.filter((c) => c.op === 'search').at(-1)).toMatchObject({
      path: DRAFTS,
      query: { all: true },
    });
    expect(body(r).drafts).toHaveLength(1);
  });
});

describe('list_labels', () => {
  test('system labels, then user labels : no special-use folder, nothing under the system container', async () => {
    const r = await run(seeded(), 'gmail__list_labels', {});
    expect(body(r).labels.map((l) => l.id)).toEqual([
      'INBOX',
      'STARRED',
      'IMPORTANT',
      'UNREAD',
      'Legal',
      'Legal/Contracts',
      'Receipts',
    ]);
  });

  test('the system container is the parent of \\All, whatever its name', () => {
    const renamed = FOLDERS.map((f) => ({
      ...f,
      path: f.path.replace('[Gmail]', '[Google Mail]'),
      parentPath: f.parentPath.replace('[Gmail]', '[Google Mail]'),
    }));
    expect(userLabels(renamed)).toEqual(['Legal', 'Legal/Contracts', 'Receipts']);
  });
});

describe('label and unlabel', () => {
  test('label_thread stores +X-GM-LABELS on every message of the thread', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__label_thread', { thread_id: T1, label: 'STARRED' });
    expect(body(r)).toMatchObject({
      thread_id: T1,
      label: 'STARRED',
      action: 'added',
      messages: 2,
    });
    const store = t.calls.find((c) => c.op === 'store');
    expect(store).toMatchObject({ path: ALL, change: { op: 'add', labels: ['\\Starred'] } });
  });

  test('UNREAD is the absence of \\Seen', async () => {
    const t = seeded();
    await run(t, 'gmail__label_thread', { thread_id: T1, label: 'UNREAD' });
    expect(t.calls.find((c) => c.op === 'store')).toMatchObject({
      change: { op: 'remove', flags: ['\\Seen'] },
    });
    const u = seeded();
    await run(u, 'gmail__unlabel_thread', { thread_id: T1, label: 'UNREAD' });
    expect(u.calls.find((c) => c.op === 'store')).toMatchObject({
      change: { op: 'add', flags: ['\\Seen'] },
    });
  });

  test('a user label by name ; one that does not exist is never created', async () => {
    const t = seeded();
    await run(t, 'gmail__unlabel_thread', { thread_id: T1, label: 'Legal/Contracts' });
    expect(t.calls.find((c) => c.op === 'store')).toMatchObject({
      change: { op: 'remove', labels: ['Legal/Contracts'] },
    });
    const u = seeded();
    const r = await run(u, 'gmail__label_thread', { thread_id: T1, label: 'Brand-new' });
    expect(body(r)).toMatchObject({ error: 'not_found' });
    expect(u.ops()).not.toContain('store');
  });

  test('a system folder under its localized name is not a user label', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__label_thread', { thread_id: T1, label: '[Gmail]/Chats' });
    expect(r.isError).toBe(true);
    expect(t.ops()).not.toContain('store');
  });

  test('TRASH, SPAM and labels IMAP does not write are refused before any connection', async () => {
    for (const label of ['TRASH', 'spam', 'SENT', 'DRAFT', 'CATEGORY_UPDATES']) {
      const t = seeded();
      const r = await run(t, 'gmail__label_thread', { thread_id: T1, label });
      expect(r.isError).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });

  test('label_message touches the one message, and only when it belongs to the thread', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__label_message', {
      thread_id: T1,
      message_id: M2,
      label: 'IMPORTANT',
    });
    expect(body(r)).toMatchObject({ message_id: M2, messages: 1 });
    const store = t.calls.find((c) => c.op === 'store');
    expect(store && store.op === 'store' ? store.uids : null).toHaveLength(1);

    const u = seeded();
    const other = await run(u, 'gmail__label_message', {
      thread_id: T1,
      message_id: M3,
      label: 'IMPORTANT',
    });
    expect(body(other)).toMatchObject({ error: 'not_found' });
    expect(u.ops()).not.toContain('store');
  });
});

describe('the mission’s mailbox and the credential', () => {
  test('describe_zones answers from the resource, without any connection', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__describe_zones', {});
    expect(body(r)).toMatchObject({
      mailbox: MAILBOX,
      zones: { internal_domains: ['myorg.com'], sensitive_labels: ['HR'] },
    });
    expect(t.calls).toEqual([]);
  });

  test('a mailbox that is not the credential’s is refused before any connection', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__list_labels', {}, ctx([mailbox], 'other@myorg.com'));
    expect(body(r)).toMatchObject({ error: 'invalid_resource' });
    expect(t.calls).toEqual([]);
  });

  test('an unknown tool, no mailbox or two mailboxes : refused without a connection', async () => {
    const t = seeded();
    expect((await run(t, 'gmail__send_message', {})).isError).toBe(true);
    expect((await run(t, 'gmail__list_labels', {}, ctx([]))).isError).toBe(true);
    expect(
      (await run(t, 'gmail__list_labels', {}, ctx([mailbox, { ...mailbox, ref: 'b@myorg.com' }])))
        .isError,
    ).toBe(true);
    expect(t.calls).toEqual([]);
  });

  test('a refused sign-in reaches the host as UpstreamAuthError', async () => {
    const t = seeded();
    t.refuseSignIn = true;
    await expect(run(t, 'gmail__list_labels', {})).rejects.toMatchObject({
      name: 'UpstreamAuthError',
    });
  });
});

describe('textPartOf', () => {
  test('the first inline text/plain part ; a single-part message is part 1', () => {
    expect(textPartOf({ type: 'text/plain' })).toBe('1');
    expect(textPartOf({ type: 'text/html' })).toBeNull();
    expect(
      textPartOf({
        type: 'multipart/mixed',
        childNodes: [
          {
            type: 'multipart/alternative',
            part: '1',
            childNodes: [
              { type: 'text/plain', part: '1.1' },
              { type: 'text/html', part: '1.2' },
            ],
          },
          { type: 'text/plain', part: '2', disposition: 'attachment' },
        ],
      }),
    ).toBe('1.1');
    expect(
      textPartOf({
        type: 'multipart/mixed',
        childNodes: [{ type: 'text/plain', part: '1', disposition: 'attachment' }],
      }),
    ).toBeNull();
  });
});
