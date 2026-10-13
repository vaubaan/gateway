/**
 * Identifier injection : every identifier argument of the Gmail tools is fed
 * the same hostile values, to `classify` AND to `execute`.
 *
 * The plugin is classifier-only : `execute` sends nothing upstream, whatever
 * the arguments, and that is pinned here. The identifiers still land in a
 * slice today and will land in a request path (`users/me/threads/{id}`,
 * `users/me/labels/{id}`) when execution arrives, so their grammars —
 * `gmailId` and `labelRef`, exported for that executor — already make a dot
 * segment, a separator, an escape and an overlong value impossible.
 */
import { describe, expect, test } from 'vitest';
import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  MAX_GMAIL_ID_LENGTH,
  MAX_LABEL_LENGTH,
  classifyGmail,
  gmailId,
  labelRef,
} from '../../src/classify.ts';
import { GMAIL_NOT_IMPLEMENTED_CODE } from '../../src/execute.ts';
import { gmailPlugin } from '../../src/index.ts';

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
      // A nested label name (`Legal/Contracts`) is the one legitimate use of `/`.
      accepted: ['a/b'],
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
      accepted: ['a/b'],
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

/** `execute` with a fetch that would fail the test if it were ever called with a route missing. */
async function execute(tool: string, args: Record<string, unknown>) {
  const fetch = mockFetch([]);
  const ctx: ExecuteContext = {
    credential: {
      kind: 'oauth2',
      accessToken: 'ya29.test',
      refreshToken: '1//refresh',
      expiresAt: '2026-10-13T12:00:00.000Z',
      scopes: [],
      metadata: {},
    },
    appConfig: {},
    fetch,
    resources: [mailbox],
  };
  const result = await gmailPlugin.execute(ctx, tool, args);
  return { fetch, result };
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

    // Classifier-only : nothing is sent upstream, for any value.
    const { fetch, result } = await execute(position.tool, args);
    expect(fetch.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: GMAIL_NOT_IMPLEMENTED_CODE });
  });

  test.each(['q', 'to', 'cc', 'bcc'])('a hostile %s sends nothing either', async (key) => {
    const tool = key === 'q' ? 'gmail__search_threads' : 'gmail__create_draft';
    for (const value of HOSTILE) {
      const { fetch, result } = await execute(tool, { [key]: value });
      expect(fetch.calls).toHaveLength(0);
      expect(result.isError).toBe(true);
    }
  });
});

describe('gmailId — one path segment, no dot, no separator, no escape', () => {
  test.each(['18c2a9f0e1d2b3a4', 'FMfcgzQXJZsr', 'a_b-c', 'x'.repeat(MAX_GMAIL_ID_LENGTH)])(
    'accepts %j',
    (value) => {
      expect(gmailId(value)).toBe(value);
    },
  );

  test.each([
    ...HOSTILE,
    'x'.repeat(MAX_GMAIL_ID_LENGTH + 1),
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
    const outcome = classifyGmail('gmail__get_thread', { id: 'FMfcgzQXJZsr_-9' }, [mailbox]);
    if ('denied' in outcome) throw new Error(outcome.denied);
    expect(outcome.slices.map(serializeSlice)).toContain(
      'gmail.mailbox.thread[FMfcgzQXJZsr_-9].message[*].R',
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
  ])('accepts %j', (value) => {
    expect(labelRef(value)).toBe(value);
  });

  test.each([
    ...HOSTILE.filter((v) => v !== 'a/b'),
    'x'.repeat(MAX_LABEL_LENGTH + 1),
    '/a',
    'a/',
    'a//b',
    'a/./b',
    'a/..',
    './a',
    'a b',
    'a\\b',
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
