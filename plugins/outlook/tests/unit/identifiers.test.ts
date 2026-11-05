/**
 * The identifier grammars of `outlook`, and the proof that a hostile
 * identifier is refused by `classify` and by `execute` alike, before any
 * request (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { parseAddress } from '../../src/address.ts';
import { classifyOutlook } from '../../src/classify.ts';
import { executeOutlook } from '../../src/execute.ts';
import {
  folderRef,
  graphId,
  instantOf,
  localDateTime,
  mailboxRefOf,
  pathSegment,
  timeZoneName,
} from '../../src/identifiers.ts';
import { TOOL } from '../../src/identity.ts';
import { MESSAGE, context, mailbox } from './fixtures.ts';

const HOSTILE = [
  '..',
  '.',
  'a/../b',
  '../x',
  '%2e%2e',
  '..%2f',
  '%2f',
  'a/b',
  'a\nb',
  'r1?x=1#y',
  'a b',
  '*',
  '',
  'A'.repeat(513),
];

describe('grammars', () => {
  test('a Graph id: URL-safe base64, + and = kept, bounded', () => {
    expect(graphId('AAMkAGI2TG93AAA=')).toBe('AAMkAGI2TG93AAA=');
    expect(graphId('AAMk-A_b+c=')).toBe('AAMk-A_b+c=');
    for (const bad of HOSTILE) expect(graphId(bad), JSON.stringify(bad)).toBeNull();
  });

  test('a folder: a well-known name, read lower-cased, or a Graph id', () => {
    expect(folderRef('Inbox')).toBe('inbox');
    expect(folderRef('SentItems')).toBe('sentitems');
    expect(folderRef('AQMkADYAAAIBDAAAAA==')).toBe('AQMkADYAAAIBDAAAAA==');
    for (const bad of HOSTILE) expect(folderRef(bad), JSON.stringify(bad)).toBeNull();
  });

  test('a path segment is percent-encoded, never repaired', () => {
    expect(pathSegment('AAMk+A=')).toBe('AAMk%2BA%3D');
    for (const bad of ['', '.', '..', 'a/b', 'a?b', 'a#b', '%2e%2e', 'a\\b', 'a\nb']) {
      expect(pathSegment(bad), bad).toBeNull();
    }
  });

  test('a mailbox ref is the address, lower-cased, @ written ~', () => {
    expect(mailboxRefOf('Alice@Contoso.example')).toBe('alice~contoso.example');
  });

  test('times and time zones', () => {
    expect(instantOf('2026-11-05T09:00:00Z')).toBe(Date.parse('2026-11-05T09:00:00Z'));
    expect(instantOf('2026-11-05T09:00:00+01:00')).not.toBeNull();
    for (const bad of ['2026-11-05', '2026-11-05T09:00:00', 'today', 7]) {
      expect(instantOf(bad), String(bad)).toBeNull();
    }
    expect(localDateTime('2026-11-05T09:30')).toBe('2026-11-05T09:30:00');
    for (const bad of ['2026-11-05T24:00', '2026-11-05T09:30Z', '2026-02-30T09:00x']) {
      expect(localDateTime(bad), bad).toBeNull();
    }
    expect(timeZoneName('W. Europe Standard Time')).toBe('W. Europe Standard Time');
    expect(timeZoneName('Europe/Paris')).toBe('Europe/Paris');
    for (const bad of ['', 'Europe/Paris\n', 'a;b', '"UTC"', 'x'.repeat(65)]) {
      expect(timeZoneName(bad), bad).toBeNull();
    }
  });

  test('an address is exactly one address', () => {
    expect(parseAddress(' Bob@Contoso.example ')).toEqual({
      address: 'bob@contoso.example',
      local: 'bob',
      domain: 'contoso.example',
    });
    for (const bad of [
      'bob',
      'a@b',
      'a@@b.example',
      'a@b.example,c@d.example',
      'a..b@c.example',
      'Bob <b@c.example>',
    ]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe('hostile identifiers are refused by classify and by execute', () => {
  const cases: readonly [string, string, Record<string, unknown>][] = [
    [TOOL.getMessage, 'message_id', {}],
    [TOOL.getAttachment, 'attachment_id', { message_id: MESSAGE }],
    [TOOL.sendDraft, 'draft_id', { to: ['bob@contoso.example'] }],
    [TOOL.moveMessage, 'folder', { message_id: MESSAGE }],
    [TOOL.createFolder, 'parent', { name: 'x' }],
    [TOOL.searchMessages, 'folder', { query: 'from:bob@contoso.example' }],
    [TOOL.getEvent, 'event_id', {}],
    [TOOL.listEvents, 'calendar', { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' }],
  ];

  for (const [tool, argument, rest] of cases) {
    test.each(HOSTILE)(`${tool} ${argument} %j`, async (value) => {
      const args = { ...rest, [argument]: value };
      expect('denied' in classifyOutlook(tool, args, [mailbox])).toBe(true);
      const fetch = mockFetch([]);
      const result = await executeOutlook(context(fetch), tool, args);
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    });
  }

  test.each(HOSTILE.filter((v) => v !== ''))('mailbox %j', async (value) => {
    expect('denied' in classifyOutlook(TOOL.listFolders, { mailbox: value }, [mailbox])).toBe(true);
    const fetch = mockFetch([]);
    const result = await executeOutlook(context(fetch), TOOL.listFolders, { mailbox: value });
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('an accepted id names exactly the classified message, percent-encoded', async () => {
    const id = 'AAMk+A=';
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { id } }]);
    await executeOutlook(context(fetch), TOOL.getMessage, { message_id: id });
    expect(new URL(fetch.calls[0]!.url).pathname).toBe('/v1.0/me/messages/AAMk%2BA%3D');
  });
});
