/**
 * Follow-up of plugin 0.5.0 : HTML bodies converted to text, attachments
 * listed and downloaded (`get_attachment`), label names in any script with
 * spaces, and `create_label`. Against `fakeGmail()` ; no network.
 */
import { describe, expect, test } from 'vitest';

import {
  jsonObjectsOf,
  serializeSlice,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  attachmentsOf,
  bodyPartOf,
  classifyGmail,
  createGmailPlugin,
  creatableLabel,
  gmailPartId,
  htmlToText,
  labelRef,
} from '../../src/index.ts';
import { MAX_ATTACHMENT_BYTES } from '../../src/execute.ts';
import { ALL, FOLDERS, fakeGmail, message, type FakeGmail } from './fake-imap.ts';

const MAILBOX = 'me@myorg.com';
const mailbox: Resource = {
  service: 'gmail',
  ref: MAILBOX,
  displayName: MAILBOX,
  metadata: { internal_domains: ['myorg.com'], account_email: MAILBOX, sensitive_labels: ['RH'] },
};
const T1 = '18c2a9f0e1d2b3a4';
const M1 = '18c2a9f0e1d2b3a5';
const M2 = '18c2a9f0e1d2b3a6';
const dec = (hex: string) => BigInt(`0x${hex}`).toString();

const PDF = Buffer.from('%PDF-1.7 fake bytes');

function seeded(): FakeGmail {
  return fakeGmail([
    message({
      messageId: dec(M1),
      threadId: dec(T1),
      text: null,
      html:
        '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
        '<script>alert(1)</script><p>Bonjour <b>équipe</b>,</p>' +
        '<p>Voir <a href="https://example.com/facture">la facture</a> et ' +
        '<a href="https://example.com">https://example.com</a>.</p>' +
        '<img src="https://tracker.example/pixel.gif" alt="pixel"></body></html>',
      attachments: [
        { part: '2', filename: 'facture.pdf', mimeType: 'application/pdf', content: PDF },
      ],
    }),
    message({ messageId: dec(M2), threadId: dec(T1), text: 'Plain wins' }),
  ]);
}

const ctx = (): ExecuteContext => ({
  credential: {
    kind: 'api-key',
    fields: { email: MAILBOX, app_password: 'abcdefghijklmnop' },
    metadata: {},
  },
  fetch: mockFetch([]),
  resources: [mailbox],
});

const run = (t: FakeGmail, tool: string, args: Record<string, unknown>): Promise<McpToolResult> =>
  createGmailPlugin({ transport: t }).execute(ctx(), tool, args);

/** The JSON a result's text carries : the answer, or a refusal's code and words. */
const body = (r: McpToolResult) => jsonObjectsOf(r)[0] ?? {};
const messagesOf = (r: McpToolResult) => body(r).messages as readonly Record<string, unknown>[];

describe('HTML bodies', () => {
  test('an HTML-only message is read as text : links kept, script, style and images dropped', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__get_thread', { id: T1 });
    const [html, plain] = messagesOf(r);
    expect(html).toMatchObject({ text_format: 'html', text_truncated: false });
    const text = String(html?.text);
    expect(text).toContain('Bonjour équipe,');
    expect(text).toContain('la facture [https://example.com/facture]');
    // The same link as its words is written once.
    expect(text).toContain('https://example.com.');
    expect(text).not.toContain('[https://example.com]');
    expect(text).not.toMatch(/alert|color:red|pixel|tracker|<p>/);
    expect(plain).toMatchObject({ text: 'Plain wins', text_format: 'plain' });
    expect(t.calls.find((c) => c.op === 'fetch')).toMatchObject({ bodyBytes: 20_000 });
  });

  test('the converted text is capped like a plain body', () => {
    const big = `<p>${'mot '.repeat(10_000)}</p>`;
    const converted = htmlToText(big, 20_000);
    expect(converted.text).toHaveLength(20_000);
    expect(converted.truncated).toBe(true);
  });

  test('bodyPartOf prefers text/plain, falls back to text/html, ignores attachments', () => {
    const alt = {
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
        { type: 'application/pdf', part: '2', disposition: 'attachment' },
      ],
    };
    expect(bodyPartOf(alt)).toEqual({ part: '1.1', type: 'text/plain' });
    expect(
      bodyPartOf({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/html', part: '1' },
          { type: 'text/plain', part: '2', disposition: 'attachment' },
        ],
      }),
    ).toEqual({ part: '1', type: 'text/html' });
    expect(bodyPartOf({ type: 'text/html' })).toEqual({ part: '1', type: 'text/html' });
    expect(bodyPartOf({ type: 'image/png', disposition: 'attachment' })).toBeNull();
  });
});

describe('attachments', () => {
  test('attachmentsOf : parts marked attachment or carrying a file name, never the body ; decoded size', () => {
    expect(
      attachmentsOf({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain', part: '1' },
          {
            type: 'application/pdf',
            part: '2',
            disposition: 'attachment',
            dispositionParameters: { filename: 'a.pdf' },
            encoding: 'base64',
            size: 400,
          },
          { type: 'image/png', part: '3', parameters: { name: 'logo.png' }, size: 10 },
          { type: 'text/plain', part: '4', disposition: 'attachment' },
        ],
      }),
    ).toEqual([
      { part: '2', filename: 'a.pdf', mimeType: 'application/pdf', size: 300 },
      { part: '3', filename: 'logo.png', mimeType: 'image/png', size: 10 },
      { part: '4', filename: null, mimeType: 'text/plain', size: 0 },
    ]);
  });

  test('get_thread lists each message’s attachments', async () => {
    const r = await run(seeded(), 'gmail__get_thread', { id: T1 });
    expect(messagesOf(r)[0]?.attachments).toEqual([
      { part: '2', filename: 'facture.pdf', mime_type: 'application/pdf', size: PDF.length },
    ]);
    expect(messagesOf(r)[1]?.attachments).toEqual([]);
  });

  test('get_attachment returns the content in base64, read-only, by UID', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__get_attachment', { thread_id: T1, message_id: M1, part: '2' });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({
      thread_id: T1,
      message_id: M1,
      part: '2',
      filename: 'facture.pdf',
      mime_type: 'application/pdf',
      size: PDF.length,
    });
    expect(Buffer.from(String(body(r).content_base64), 'base64').equals(PDF)).toBe(true);
    expect(t.calls.find((c) => c.op === 'download')).toMatchObject({
      path: ALL,
      part: '2',
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    expect(t.ops()).not.toContain('store');
  });

  test('larger than 5 MiB : refused by the listed size, before any download', async () => {
    const t = fakeGmail([
      message({
        messageId: dec(M1),
        threadId: dec(T1),
        attachments: [
          {
            part: '2',
            filename: 'big.zip',
            mimeType: 'application/zip',
            content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
          },
        ],
      }),
    ]);
    const r = await run(t, 'gmail__get_attachment', { thread_id: T1, message_id: M1, part: '2' });
    expect(body(r)).toMatchObject({ error: 'too_large' });
    expect(String(body(r).message)).toMatch(/at most 5242880 bytes \(5 MiB\)/);
    expect(t.ops()).not.toContain('download');
  });

  test('a part that is not an attachment, or a message outside the thread : not_found', async () => {
    const t = seeded();
    expect(
      body(await run(t, 'gmail__get_attachment', { thread_id: T1, message_id: M1, part: '1' })),
    ).toMatchObject({ error: 'not_found' });
    expect(
      body(
        await run(t, 'gmail__get_attachment', {
          thread_id: T1,
          message_id: 'abcdef',
          part: '2',
        }),
      ),
    ).toMatchObject({ error: 'not_found' });
    expect(t.ops()).not.toContain('download');
  });

  test.each(['', '0', '01', '1.', '.1', '1..2', '1.a', 'HEADER', '1]', '2 ', '1'.repeat(5)])(
    'a part %j outside the grammar is refused by classify and opens no connection',
    async (part) => {
      expect(gmailPartId(part)).toBeNull();
      expect(
        classifyGmail('gmail__get_attachment', { thread_id: T1, message_id: M1, part }, [mailbox]),
      ).toHaveProperty('denied');
      const t = seeded();
      const r = await run(t, 'gmail__get_attachment', { thread_id: T1, message_id: M1, part });
      expect(r.isError).toBe(true);
      expect(t.calls).toEqual([]);
    },
  );

  test('get_attachment is classified like get_thread, the sensitive marker included', () => {
    const outcome = classifyGmail(
      'gmail__get_attachment',
      { thread_id: T1, message_id: M1, part: '1.2' },
      [mailbox],
    );
    if ('denied' in outcome) throw new Error(outcome.denied);
    expect(outcome.slices.map(serializeSlice)).toEqual([
      `gmail.mailbox.thread[${T1}].message[${M1}].R`,
      'gmail.mailbox.from-zone[unknown].R',
      'gmail.mailbox.sensitive-label[*].R',
    ]);
  });
});

describe('label names with spaces and accents', () => {
  const withLabel = (path: string): FakeGmail => {
    const t = seeded();
    t.folders = [...FOLDERS, { path, specialUse: null, selectable: true, parentPath: '' }];
    return t;
  };

  test.each(['Clients 2026', 'Factures payées', 'Projets/Été'])(
    'a write on %j stores the server’s name',
    async (name) => {
      const t = withLabel(name);
      const r = await run(t, 'gmail__label_thread', { thread_id: T1, label: name });
      expect(r.isError).toBeUndefined();
      expect(t.calls.find((c) => c.op === 'store')).toMatchObject({
        change: { op: 'add', labels: [name] },
      });
    },
  );

  test('a name typed decomposed (NFD) finds the label listed composed', async () => {
    const t = withLabel('Été');
    await run(t, 'gmail__label_thread', { thread_id: T1, label: 'Été'.normalize('NFD') });
    expect(t.calls.find((c) => c.op === 'store')).toMatchObject({
      change: { labels: ['Été'] },
    });
  });

  test('sensitive matching folds case and spaces, and a name that is no slice identifier is `*`', () => {
    const md = {
      ...mailbox,
      metadata: { ...mailbox.metadata, sensitive_labels: ['Ressources Humaines'] },
    };
    const outcome = classifyGmail(
      'gmail__label_thread',
      { thread_id: T1, label: 'ressources humaines/Paies' },
      [md],
    );
    if ('denied' in outcome) throw new Error(outcome.denied);
    expect(outcome.slices.map(serializeSlice)).toContain('gmail.mailbox.sensitive-label[*].W');
  });

  test('labelRef bounds : the length is counted in characters', () => {
    expect(labelRef('é'.repeat(225))).not.toBeNull();
    expect(labelRef('é'.repeat(226))).toBeNull();
  });
});

describe('create_label', () => {
  test('CREATE from the segments ; classified as label-create', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__create_label', { name: 'Projets/Été 2026' });
    expect(body(r)).toEqual({ label: 'Projets/Été 2026', created: true });
    expect(t.calls.filter((c) => c.op === 'create')).toEqual([
      { op: 'create', segments: ['Projets', 'Été 2026'] },
    ]);
    const outcome = classifyGmail('gmail__create_label', { name: 'Clients/2026' }, [mailbox]);
    expect('slices' in outcome && outcome.slices.map(serializeSlice)).toEqual([
      'gmail.mailbox.label[Clients/2026].W',
    ]);
  });

  test('a name that exists, in any case, is refused and nothing is created', async () => {
    const t = seeded();
    const r = await run(t, 'gmail__create_label', { name: 'legal/contracts' });
    expect(body(r)).toMatchObject({ error: 'already_exists' });
    expect(t.ops()).not.toContain('create');
  });

  test('a name that is a special-use folder, or under the system container, is refused', async () => {
    const t = seeded();
    t.folders = [
      ...FOLDERS,
      { path: 'Suivis', specialUse: '\\Flagged', selectable: true, parentPath: '' },
    ];
    expect(body(await run(t, 'gmail__create_label', { name: 'Suivis' }))).toMatchObject({
      error: 'invalid_argument',
    });
    const u = seeded();
    u.folders = FOLDERS.map((f) => ({
      ...f,
      path: f.path.replace('[Gmail]', 'Système'),
      parentPath: f.parentPath.replace('[Gmail]', 'Système'),
    }));
    expect(body(await run(u, 'gmail__create_label', { name: 'Système/Nouveau' }))).toMatchObject({
      error: 'invalid_argument',
    });
    expect([...t.ops(), ...u.ops()]).not.toContain('create');
  });

  test('a sensitive name, or one nested under it, also carries the sensitive-label marker', () => {
    for (const name of ['RH', 'rh/Paies']) {
      const outcome = classifyGmail('gmail__create_label', { name }, [mailbox]);
      if ('denied' in outcome) throw new Error(outcome.denied);
      expect(outcome.slices.map(serializeSlice)).toContain('gmail.mailbox.sensitive-label[RH].W');
    }
  });

  test.each([
    'TRASH',
    'Spam',
    'INBOX',
    'inbox/x',
    'STARRED',
    'CATEGORY_UPDATES',
    '[Gmail]/X',
    '[Google Mail]',
  ])('creatableLabel refuses %j', (name) => {
    expect(creatableLabel(name)).toBeNull();
  });
});
