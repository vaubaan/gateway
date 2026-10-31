/**
 * Identifier injection : every identifier argument of the Gmail tools is fed
 * the same hostile values, to `classify` AND to `execute`.
 *
 * The identifiers land in a slice and, converted to their decimal value, in
 * an IMAP `SEARCH` ; a label lands in a `STORE`. Their grammars — `gmailId`
 * (16 lower-case hexadecimal digits at most) and `labelRef` / `writableLabel`
 * — are the ones `execute` takes them from (ADR
 * plugin-identifiers-one-grammar-for-classify-and-execute), so a value
 * `classify` refuses opens no IMAP connection at all, which is pinned here
 * against a fake transport.
 */
import { describe, expect, test } from 'vitest';
import {
  jsonObjectsOf,
  serializeSlice,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  MAX_GMAIL_ID_LENGTH,
  MAX_LABEL_LENGTH,
  classifyGmail,
  gmailId,
  labelRef,
} from '../../src/classify.ts';
import { createGmailPlugin } from '../../src/index.ts';
import { fakeGmail, message } from './fake-imap.ts';

const mailbox: Resource = {
  provider: 'gmail',
  ref: 'me@myorg.com',
  displayName: 'me@myorg.com',
  env: null,
  metadata: { internal_domains: ['myorg.com'], account_email: 'me@myorg.com' },
};

const LONG = 'x'.repeat(5000);

/** The values every identifier position is fed. */
const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  '',
  LONG,
  'a\nb',
  'a?x=1#y',
];

interface Position {
  readonly name: string;
  readonly tool: string;
  readonly args: (value: unknown) => Record<string, unknown>;
  /** The hostile values that are legitimate here ; every other one must be refused. */
  readonly accepted: readonly string[];
  /** The slice an accepted value must produce — it names that value and nothing else. */
  readonly slice: (value: string) => string;
}

const ids = { thread_id: '18c2a9f0e1d2b3a4', message_id: '18c2a9f0e1d2b3a5' };

const POSITIONS: readonly Position[] = [
  ...(['thread_id', 'message_id', 'part'] as const).map((key): Position => ({
    name: `get_attachment.${key}`,
    tool: 'gmail__get_attachment',
    args: (v) => ({ ...ids, part: '2', [key]: v }),
    accepted: [],
    slice: () => '',
  })),
  {
    name: 'get_thread.id',
    tool: 'gmail__get_thread',
    args: (v) => ({ id: v }),
    accepted: [],
    slice: (v) => `gmail.mailbox.thread[${v}].message[*].R`,
  },
  ...(['gmail__label_message', 'gmail__unlabel_message'] as const).flatMap((tool): Position[] => [
    {
      name: `${tool.slice('gmail__'.length)}.thread_id`,
      tool,
      args: (v) => ({ ...ids, thread_id: v, label: 'STARRED' }),
      accepted: [],
      slice: (v) => `gmail.mailbox.thread[${v}].message[${ids.message_id}].label.W`,
    },
    {
      name: `${tool.slice('gmail__'.length)}.message_id`,
      tool,
      args: (v) => ({ ...ids, message_id: v, label: 'STARRED' }),
      accepted: [],
      slice: (v) => `gmail.mailbox.thread[${ids.thread_id}].message[${v}].label.W`,
    },
    {
      name: `${tool.slice('gmail__'.length)}.label`,
      tool,
      args: (v) => ({ ...ids, label: v }),
      // A nested label name (`Legal/Contracts`) is the one legitimate use of `/` ;
      // `?`, `=` and `#` are punctuation a label name may hold (it reaches no URL).
      accepted: ['a/b', 'a?x=1#y'],
      slice: () => `gmail.mailbox.thread[${ids.thread_id}].message[${ids.message_id}].label.W`,
    },
  ]),
  ...(['gmail__label_thread', 'gmail__unlabel_thread'] as const).flatMap((tool): Position[] => [
    {
      name: `${tool.slice('gmail__'.length)}.thread_id`,
      tool,
      args: (v) => ({ thread_id: v, label: 'STARRED' }),
      accepted: [],
      slice: (v) => `gmail.mailbox.thread[${v}].label.W`,
    },
    {
      name: `${tool.slice('gmail__'.length)}.label`,
      tool,
      args: (v) => ({ thread_id: ids.thread_id, label: v }),
      accepted: ['a/b', 'a?x=1#y'],
      slice: () => `gmail.mailbox.thread[${ids.thread_id}].label.W`,
    },
  ]),
];

const label = (value: unknown): string =>
  typeof value === 'string' && value.length > 40
    ? `a ${value.length}-character value`
    : JSON.stringify(value);

const CASES = POSITIONS.flatMap((position) =>
  HOSTILE.map((value) => [position.name, label(value), position, value] as const),
);

/** `execute` over a fake mailbox holding the thread and message of `ids`. */
async function execute(tool: string, args: Record<string, unknown>) {
  const transport = fakeGmail([
    message({
      messageId: BigInt(`0x${ids.message_id}`).toString(),
      threadId: BigInt(`0x${ids.thread_id}`).toString(),
    }),
  ]);
  const ctx: ExecuteContext = {
    credential: {
      kind: 'api-key',
      fields: { email: 'me@myorg.com', app_password: 'abcdefghijklmnop' },
      metadata: {},
    },
    fetch: mockFetch([]),
    resources: [mailbox],
  };
  const result = await createGmailPlugin({ transport }).execute(ctx, tool, args);
  return { transport, result };
}

describe('identifier positions — hostile values', () => {
  test.each(CASES)('%s = %s', async (_name, _label, position, value) => {
    const args = position.args(value);
    const outcome = classifyGmail(position.tool, args, [mailbox]);
    if (position.accepted.includes(value)) {
      if ('denied' in outcome) throw new Error(`unexpected denial: ${outcome.denied}`);
      expect(outcome.slices.map(serializeSlice)).toEqual([position.slice(value)]);
    } else {
      expect(outcome).toHaveProperty('denied');
    }

    const { transport, result } = await execute(position.tool, args);
    expect(result.isError).toBe(true);
    if (position.accepted.includes(value)) {
      // A label name nobody created : looked up, never stored (a STORE would create it).
      expect(jsonObjectsOf(result)[0]).toMatchObject({ error: 'not_found' });
      expect(transport.ops()).not.toContain('store');
    } else {
      // What classify refuses, execute refuses too, before any IMAP connection.
      expect(transport.calls).toEqual([]);
    }
  });

  test.each(['to', 'cc', 'bcc'])('a hostile %s opens no IMAP connection', async (key) => {
    for (const value of HOSTILE) {
      const { transport, result } = await execute('gmail__create_draft', {
        [key]: value,
        subject: 's',
        body: 'b',
      });
      expect(transport.calls).toEqual([]);
      expect(result.isError).toBe(true);
    }
  });

  test('a query is one X-GM-RAW criterion and nothing else ; empty, overlong or multi-line, it is refused', async () => {
    for (const value of HOSTILE) {
      const { transport, result } = await execute('gmail__search_threads', { q: value });
      if (value === '' || value === LONG || value.includes('\n')) {
        expect(transport.calls).toEqual([]);
        expect(result.isError).toBe(true);
        continue;
      }
      const searches = transport.calls.filter((c) => c.op === 'search');
      expect(searches).toEqual([
        { op: 'search', path: '[Gmail]/Tous les messages', query: { gmailRaw: value } },
      ]);
      expect(transport.ops()).not.toContain('store');
      expect(transport.ops()).not.toContain('append');
    }
  });
});

describe('gmailId — up to 16 lower-case hexadecimal digits, the 64 bits of X-GM-THRID / X-GM-MSGID', () => {
  test.each(['18c2a9f0e1d2b3a4', '0', 'ffffffffffffffff', 'a'.repeat(MAX_GMAIL_ID_LENGTH)])(
    'accepts %j',
    (value) => {
      expect(gmailId(value)).toBe(value);
    },
  );

  test.each([
    ...HOSTILE,
    'a'.repeat(MAX_GMAIL_ID_LENGTH + 1),
    'FMfcgzQXJZsr',
    '18C2A9F0E1D2B3A4',
    'a_b-c',
    '0x18c2',
    'a b',
    'a.b',
    'a\\b',
    'a\u0000',
    'a%',
    'аbc',
    ' abc',
    42,
    null,
    undefined,
    ['abc'],
  ])('refuses %j', (value) => {
    expect(gmailId(value)).toBeNull();
  });

  test('an accepted id reaches the slice as it is', () => {
    const outcome = classifyGmail('gmail__get_thread', { id: '18c2a9f0e1d2b3a4' }, [mailbox]);
    if ('denied' in outcome) throw new Error(outcome.denied);
    expect(outcome.slices.map(serializeSlice)).toContain(
      'gmail.mailbox.thread[18c2a9f0e1d2b3a4].message[*].R',
    );
  });
});

describe('labelRef — a label id or a label name, never a dot segment', () => {
  test.each([
    'INBOX',
    'CATEGORY_UPDATES',
    'Label_42',
    'Legal/Contracts',
    'v1.2',
    'a.b/c.d',
    'x'.repeat(MAX_LABEL_LENGTH),
    'é'.repeat(MAX_LABEL_LENGTH),
    'Clients 2026',
    'Factures payées',
    'Projets/Été',
    'Équipe – Paris',
    "L'équipe (RH)",
    'Заказы',
    '請求書/2026',
    'a b',
    'a?x=1#y',
  ])('accepts %j', (value) => {
    expect(labelRef(value)).toBe(value);
  });

  test.each([
    ...HOSTILE.filter((v) => v !== 'a/b' && v !== 'a?x=1#y'),
    'x'.repeat(MAX_LABEL_LENGTH + 1),
    '/a',
    'a/',
    'a//b',
    'a/./b',
    'a/..',
    './a',
    'x'.repeat(MAX_LABEL_LENGTH) + 'é',
    ' a',
    'a ',
    'a / b',
    'a/ b',
    'a\tb',
    'a\r\nb',
    'a\nA001 DELETE INBOX',
    'a\u0085b',
    'a\u009bb',
    'a\u007fb',
    'a\u200bb',
    'a"b',
    '"a"',
    'a\\b',
    'a\\"',
    'a{5}',
    '{3}\r\nabc',
    'a*',
    'a%',
    '[Gmail]/Corbeille',
    'a<b>',
    'a|b',
    'a`b',
    'a\u0000',
    42,
    null,
    undefined,
  ])('refuses %j', (value) => {
    expect(labelRef(value)).toBeNull();
  });

  test.each(['..', '.', 'a/../b', 'a/..', '/a', 'a//b', LONG])(
    'a label write naming %j is refused as malformed',
    (value) => {
      for (const tool of ['gmail__label_thread', 'gmail__unlabel_thread']) {
        expect(classifyGmail(tool, { thread_id: ids.thread_id, label: value }, [mailbox])).toEqual({
          denied: 'label: malformed.',
        });
      }
    },
  );
});

describe('create_label.name — hostile values', () => {
  test.each(HOSTILE.map((v) => [label(v), v] as const))('%s', async (_label, value) => {
    const outcome = classifyGmail('gmail__create_label', { name: value }, [mailbox]);
    const { transport, result } = await execute('gmail__create_label', { name: value });
    if (value === 'a/b' || value === 'a?x=1#y') {
      // A label name: classified as one, created from its segments, nothing else sent.
      if ('denied' in outcome) throw new Error(`unexpected denial: ${outcome.denied}`);
      expect(outcome.slices.map(serializeSlice)).toEqual([
        value === 'a/b' ? 'gmail.mailbox.label[a/b].W' : 'gmail.mailbox.label[*].W',
      ]);
      expect(transport.calls.filter((c) => c.op === 'create')).toEqual([
        { op: 'create', segments: value.split('/') },
      ]);
      expect(transport.ops()).not.toContain('store');
      return;
    }
    expect(outcome).toHaveProperty('denied');
    expect(result.isError).toBe(true);
    expect(transport.calls).toEqual([]);
  });

  test.each([
    'a"b',
    'a\\b',
    'a{5}',
    '{3}\r\nabc',
    'a\r\nA001 DELETE INBOX',
    'TRASH',
    'spam',
    'INBOX',
    'Inbox/Sub',
    'CATEGORY_SOCIAL',
    '[Gmail]',
    '[Google Mail]/Sent',
  ])('refuses %j before any connection', async (value) => {
    expect(classifyGmail('gmail__create_label', { name: value }, [mailbox])).toHaveProperty(
      'denied',
    );
    const { transport, result } = await execute('gmail__create_label', { name: value });
    expect(result.isError).toBe(true);
    expect(transport.calls).toEqual([]);
  });
});
