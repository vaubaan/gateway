/**
 * Execution of the mail tools against a mock of Microsoft Graph: what leaves
 * (the Bearer, the Prefer header, the method, the path, the query, the body
 * built from what the reader returned), what comes back (writes reduced to
 * ids and recipients), the two-step tools (reply draft, send draft, move to
 * a folder id, attachment), the thrown failures and the refusals that send
 * nothing.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError, UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { executeOutlook } from '../../src/execute.ts';
import { TOOL } from '../../src/identity.ts';
import { filterOf, holdsQuery } from '../../src/mail.ts';
import { parseQuery } from '../../src/q-parser.ts';
import {
  ACCOUNT,
  ATTACHMENT,
  DRAFT,
  FOLDER,
  MAILBOX,
  MESSAGE,
  STORED_DRAFT,
  TOKEN,
  context,
  requestOf,
} from './fixtures.ts';

function json(result: { readonly content: readonly { type: string; text?: string }[] }): unknown {
  const [first] = result.content;
  return JSON.parse(first?.type === 'text' ? (first.text ?? '') : 'null') as unknown;
}

const message = (from: string, extra: Record<string, unknown> = {}) => ({
  id: 'M1',
  subject: 'Invoice Q4',
  from: { emailAddress: { address: from } },
  toRecipients: [{ emailAddress: { address: ACCOUNT } }],
  isRead: false,
  hasAttachments: true,
  receivedDateTime: '2026-10-15T09:00:00Z',
  ...extra,
});

describe('headers and reads', () => {
  test('every request carries the Bearer and the immutable-id Prefer; a message read asks for text', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { id: MESSAGE, body: {} } }]);
    await executeOutlook(context(fetch), TOOL.getMessage, { message_id: MESSAGE });
    const [call] = fetch.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.prefer).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
    expect(requestOf(call!).path).toBe(`/me/messages/${MESSAGE}`);
    expect(requestOf(call!).query.$select).toContain('body');
  });

  test('describe_zones is answered by the gateway, without a request', async () => {
    const fetch = mockFetch([]);
    const result = await executeOutlook(context(fetch), TOOL.describeZones, {});
    expect(fetch.calls).toHaveLength(0);
    expect(json(result)).toEqual({
      mailbox: MAILBOX,
      zones: {
        account_email: ACCOUNT,
        internal_domains: ['contoso.example'],
        allowlist_domains: ['partner.example'],
        allowlist_addresses: ['carol@customer.example'],
      },
    });
  });

  test('list_folders: the top, or the children of a folder', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { value: [] } }]);
    await executeOutlook(context(fetch), TOOL.listFolders, {});
    await executeOutlook(context(fetch), TOOL.listFolders, { parent: 'Inbox' });
    expect(fetch.calls.map((c) => requestOf(c).path)).toEqual([
      '/me/mailFolders',
      '/me/mailFolders/inbox/childFolders',
    ]);
    expect(requestOf(fetch.calls[0]!).query.$top).toBe('100');
  });

  test('list_attachments and list_drafts', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { value: [] } }]);
    await executeOutlook(context(fetch), TOOL.listAttachments, { message_id: MESSAGE });
    await executeOutlook(context(fetch), TOOL.listDrafts, {});
    expect(requestOf(fetch.calls[0]!).path).toBe(`/me/messages/${MESSAGE}/attachments`);
    expect(requestOf(fetch.calls[1]!)).toMatchObject({
      path: '/me/mailFolders/drafts/messages',
      query: { $top: '25', $orderby: 'lastModifiedDateTime desc' },
    });
  });
});

describe('search_messages', () => {
  test('fielded terms: a $filter led by receivedDateTime, newest first', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: () => true, body: { value: [message("o'neil@contoso.example")] } },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.searchMessages, {
      query:
        "from:o'neil@contoso.example is:unread has:attachment after:2026-10-01 before:2026-11-01",
      folder: 'inbox',
      top: 5,
    });
    const { path, query } = requestOf(fetch.calls[0]!);
    expect(path).toBe('/me/mailFolders/inbox/messages');
    expect(query).toMatchObject({
      $filter:
        "receivedDateTime ge 2026-10-01T00:00:00Z and receivedDateTime lt 2026-11-01T00:00:00Z and from/emailAddress/address eq 'o''neil@contoso.example' and isRead eq false and hasAttachments eq true",
      $orderby: 'receivedDateTime desc',
      $top: '5',
    });
    expect(query.$search).toBeUndefined();
    expect((json(result) as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test('free words: a $search, never with $filter; the sender bound applied to what comes back', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: { value: [message('bob@contoso.example'), message('eve@elsewhere.example')] },
      },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.searchMessages, {
      query: 'from:bob@contoso.example invoice Q4',
    });
    const { path, query } = requestOf(fetch.calls[0]!);
    expect(path).toBe('/me/messages');
    expect(query.$search).toBe('"invoice Q4"');
    expect(query.$filter).toBeUndefined();
    expect(query.$orderby).toBeUndefined();
    const kept = (json(result) as { messages: { from: unknown }[] }).messages;
    expect(kept).toEqual([message('bob@contoso.example')]);
  });

  test('an empty query: the newest messages', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { value: [] } }]);
    await executeOutlook(context(fetch), TOOL.searchMessages, { query: '' });
    expect(requestOf(fetch.calls[0]!).query).toMatchObject({
      $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z',
      $top: '10',
    });
  });

  test('holdsQuery: each term checked; a message whose fields cannot be read does not hold', () => {
    const q = (text: string) => {
      const out = parseQuery(text);
      if ('denied' in out) throw new Error(out.denied);
      return out.query;
    };
    const m = message('bob@contoso.example');
    expect(holdsQuery(m, q('from:bob@contoso.example subject:invoice'))).toBe(true);
    expect(holdsQuery(m, q(`to:${ACCOUNT} is:unread has:attachment after:2026-10-01`))).toBe(true);
    expect(holdsQuery(m, q('from:eve@x.example'))).toBe(false);
    expect(holdsQuery(m, q('subject:payroll'))).toBe(false);
    expect(holdsQuery(m, q('before:2026-10-01'))).toBe(false);
    expect(holdsQuery({ id: 'x' }, q('from:bob@contoso.example'))).toBe(false);
    expect(holdsQuery({ ...m, receivedDateTime: 'yesterday' }, q('after:2026-01-01'))).toBe(false);
    expect(filterOf(q('to:x@y.example subject:a'))).toBe(
      'receivedDateTime ge 1900-01-01T00:00:00Z',
    );
  });
});

describe('attachments', () => {
  test('a file: its description first, then its content', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => u.includes('%24select'),
        body: { '@odata.type': '#microsoft.graph.fileAttachment', id: ATTACHMENT, size: 1200 },
      },
      { method: 'GET', url: () => true, body: { id: ATTACHMENT, contentBytes: 'aGVsbG8=' } },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.getAttachment, {
      message_id: MESSAGE,
      attachment_id: ATTACHMENT,
    });
    expect(fetch.calls.map((c) => requestOf(c).path)).toEqual([
      `/me/messages/${MESSAGE}/attachments/${ATTACHMENT}`,
      `/me/messages/${MESSAGE}/attachments/${ATTACHMENT}`,
    ]);
    expect(json(result)).toEqual({ id: ATTACHMENT, contentBytes: 'aGVsbG8=' });
  });

  test('larger than 7 MB is refused before the download; an item is described only', async () => {
    const big = mockFetch([
      { method: 'GET', url: () => true, body: { id: ATTACHMENT, size: 8 * 1024 * 1024 } },
    ]);
    expect(
      await refusalText(
        executeOutlook(context(big), TOOL.getAttachment, {
          message_id: MESSAGE,
          attachment_id: ATTACHMENT,
        }),
      ),
    ).toMatch(/larger than/);
    expect(big.calls).toHaveLength(1);
    const item = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: { '@odata.type': '#microsoft.graph.itemAttachment', id: ATTACHMENT },
      },
    ]);
    const result = await executeOutlook(context(item), TOOL.getAttachment, {
      message_id: MESSAGE,
      attachment_id: ATTACHMENT,
    });
    expect(item.calls).toHaveLength(1);
    expect(json(result)).toMatchObject({
      note: expect.stringMatching(/not downloaded/) as unknown,
    });
  });
});

describe('drafts and sends', () => {
  test('create_draft: a text body, recipients as Graph objects; the answer reduced', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: () => true, body: { id: DRAFT, body: { content: 'x' } } },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.createDraft, {
      to: ['Bob@Contoso.example'],
      subject: 'Plan',
      body: '<b>not html</b>',
    });
    expect(requestOf(fetch.calls[0]!).path).toBe('/me/messages');
    expect(fetch.calls[0]?.json).toEqual({
      subject: 'Plan',
      body: { contentType: 'Text', content: '<b>not html</b>' },
      toRecipients: [{ emailAddress: { address: 'bob@contoso.example' } }],
      ccRecipients: [],
      bccRecipients: [],
    });
    expect(json(result)).toEqual({
      draft_id: DRAFT,
      subject: 'Plan',
      to: ['bob@contoso.example'],
      cc: [],
      bcc: [],
    });
  });

  test('create_reply_draft: createReplyAll, then the recipients replaced by the declared ones', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: (u) => u.endsWith('/createReplyAll'),
        body: { id: 'R1', body: { content: 'secret quote' } },
      },
      { method: 'PATCH', url: () => true, body: { id: 'R1' } },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.createReplyDraft, {
      message_id: MESSAGE,
      body: 'Thanks',
      to: ['bob@contoso.example'],
      cc: ['dan@partner.example'],
      reply_all: true,
    });
    expect(fetch.calls.map((c) => `${c.method} ${requestOf(c).path}`)).toEqual([
      `POST /me/messages/${MESSAGE}/createReplyAll`,
      'PATCH /me/messages/R1',
    ]);
    expect(fetch.calls[0]?.json).toEqual({ comment: 'Thanks' });
    expect(fetch.calls[1]?.json).toEqual({
      toRecipients: [{ emailAddress: { address: 'bob@contoso.example' } }],
      ccRecipients: [{ emailAddress: { address: 'dan@partner.example' } }],
      bccRecipients: [],
    });
    expect(JSON.stringify(json(result))).not.toContain('secret quote');
  });

  test('create_reply_draft: a failed PATCH deletes the new draft and throws', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: () => true, body: { id: 'R1' } },
      {
        method: 'PATCH',
        url: () => true,
        status: 503,
        body: { error: { code: 'ServiceUnavailable' } },
      },
      { method: 'DELETE', url: () => true, status: 204 },
    ]);
    await expect(
      executeOutlook(context(fetch), TOOL.createReplyDraft, {
        message_id: MESSAGE,
        body: 'x',
        to: [ACCOUNT],
      }),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE']);
  });

  test('create_reply_draft: a draft id outside the grammar is a protocol failure', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, body: { id: '../x' } }]);
    await expect(
      executeOutlook(context(fetch), TOOL.createReplyDraft, {
        message_id: MESSAGE,
        body: 'x',
        to: [ACCOUNT],
      }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    expect(fetch.calls).toHaveLength(1);
  });

  test('send_message: sendMail, saved to Sent Items', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, status: 202 }]);
    const result = await executeOutlook(context(fetch), TOOL.sendMessage, {
      to: ['eve@elsewhere.example'],
      bcc: [ACCOUNT],
      subject: 'Hello',
      body: 'Text',
    });
    expect(requestOf(fetch.calls[0]!).path).toBe('/me/sendMail');
    expect(fetch.calls[0]?.json).toMatchObject({
      saveToSentItems: true,
      message: { subject: 'Hello', body: { contentType: 'Text', content: 'Text' } },
    });
    expect(json(result)).toMatchObject({ sent: true, to: ['eve@elsewhere.example'] });
  });

  test('send_draft: the stored draft compared with the declared recipients, then sent', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: () => true, body: STORED_DRAFT },
      { method: 'POST', url: () => true, status: 202 },
    ]);
    await executeOutlook(context(fetch), TOOL.sendDraft, {
      draft_id: DRAFT,
      to: ['bob@contoso.example'],
    });
    expect(fetch.calls.map((c) => `${c.method} ${requestOf(c).path}`)).toEqual([
      `GET /me/messages/${DRAFT}`,
      `POST /me/messages/${DRAFT}/send`,
    ]);
  });

  test.each([
    [
      'another recipient',
      { ...STORED_DRAFT, ccRecipients: [{ emailAddress: { address: 'eve@else.example' } }] },
      /addressed cc/,
    ],
    ['not a draft', { ...STORED_DRAFT, isDraft: false }, /not a draft/],
    [
      'a recipient that is not an address',
      { ...STORED_DRAFT, toRecipients: [{ emailAddress: { address: 'Bob' } }] },
      /not one address/,
    ],
  ])('send_draft refuses %s, unsent', async (_label, stored, why) => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: stored }]);
    expect(
      await refusalText(
        executeOutlook(context(fetch), TOOL.sendDraft, {
          draft_id: DRAFT,
          to: ['bob@contoso.example'],
        }),
      ),
    ).toMatch(why);
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('organise', () => {
  test('a move to a well-known folder: one POST, the answer reduced', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: () => true, body: { id: 'NEW', body: { content: 'secret' } } },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.moveMessage, {
      message_id: MESSAGE,
      folder: 'Archive',
    });
    expect(fetch.calls[0]?.json).toEqual({ destinationId: 'archive' });
    expect(json(result)).toEqual({ moved: true, message_id: 'NEW', folder: 'archive' });
  });

  test('a move to a folder id under Deleted Items is refused, unmoved', async () => {
    const ids: Record<string, { id: string; parentFolderId?: string }> = {
      deleteditems: { id: 'DEL' },
      junkemail: { id: 'JUNK' },
      outbox: { id: 'OUT' },
      msgfolderroot: { id: 'ROOT' },
      [FOLDER]: { id: FOLDER, parentFolderId: 'SUB' },
      SUB: { id: 'SUB', parentFolderId: 'DEL' },
    };
    const nameOf = (url: string) =>
      decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => ids[nameOf(u)] !== undefined,
        respond: (call) => ids[nameOf(call.url)],
      },
      {
        method: 'GET',
        url: () => true,
        status: 404,
        body: { error: { code: 'ErrorItemNotFound' } },
      },
    ]);
    expect(
      await refusalText(
        executeOutlook(context(fetch), TOOL.moveMessage, { message_id: MESSAGE, folder: FOLDER }),
      ),
    ).toMatch(/is under, a folder that deletes or sends mail; nothing was moved/);
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('a move to a folder id under the root is sent', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        respond: (call) => {
          const name = new URL(call.url).pathname.split('/').pop() ?? '';
          return name === FOLDER
            ? { id: FOLDER, parentFolderId: 'ROOT' }
            : { id: name === 'msgfolderroot' ? 'ROOT' : name.toUpperCase() };
        },
      },
      { method: 'POST', url: () => true, body: { id: MESSAGE } },
    ]);
    await executeOutlook(context(fetch), TOOL.moveMessage, { message_id: MESSAGE, folder: FOLDER });
    expect(fetch.calls.at(-1)?.json).toEqual({ destinationId: FOLDER });
  });

  test('update_message: field by field, the answer without the body', async () => {
    const fetch = mockFetch([
      {
        method: 'PATCH',
        url: () => true,
        body: { id: MESSAGE, isRead: true, body: { content: 'secret' } },
      },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.updateMessage, {
      message_id: MESSAGE,
      is_read: true,
      flag: 'complete',
      categories: ['Red category'],
    });
    expect(fetch.calls[0]?.json).toEqual({
      isRead: true,
      flag: { flagStatus: 'complete' },
      categories: ['Red category'],
    });
    expect(JSON.stringify(json(result))).not.toContain('secret');
  });

  test('create_folder: at the top or under a parent', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: () => true, body: { id: 'F2', displayName: 'Q4' } },
    ]);
    await executeOutlook(context(fetch), TOOL.createFolder, { name: 'Q4' });
    await executeOutlook(context(fetch), TOOL.createFolder, { name: 'Q4', parent: FOLDER });
    expect(fetch.calls.map((c) => requestOf(c).path)).toEqual([
      '/me/mailFolders',
      `/me/mailFolders/${FOLDER}/childFolders`,
    ]);
    expect(fetch.calls[0]?.json).toEqual({ displayName: 'Q4' });
  });
});

describe('failures and refusals', () => {
  test('401 and 403 are UpstreamAuthError, 429 an UpstreamHttpError, a body that is not the shape a protocol failure', async () => {
    for (const [status, type] of [
      [401, UpstreamAuthError],
      [403, UpstreamAuthError],
      [429, UpstreamHttpError],
    ] as const) {
      const fetch = mockFetch([
        { url: () => true, status, body: { error: { code: 'ErrorAccessDenied' } } },
      ]);
      await expect(executeOutlook(context(fetch), TOOL.listFolders, {})).rejects.toBeInstanceOf(
        type,
      );
    }
    const shape = mockFetch([{ url: () => true, body: { value: 'not a list' } }]);
    await expect(executeOutlook(context(shape), TOOL.listFolders, {})).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });

  test('what the reader refuses sends nothing', async () => {
    const fetch = mockFetch([]);
    for (const [tool, args] of [
      [TOOL.sendMessage, { to: ['bob'], subject: 's', body: 'b' }],
      [TOOL.createDraft, { to: ['eve@else.example'], subject: 's', body: 'b' }],
      [TOOL.moveMessage, { message_id: MESSAGE, folder: 'deleteditems' }],
      [TOOL.getMessage, { message_id: MESSAGE, extra: 1 }],
      ['outlook__delete_message', { message_id: MESSAGE }],
    ] as const) {
      expect(await refusalText(executeOutlook(context(fetch), tool, args)), tool).not.toBe('');
    }
    expect(await refusalText(executeOutlook(context(fetch, []), TOOL.listFolders, {}))).toMatch(
      /no Outlook mailbox/,
    );
    expect(fetch.calls).toHaveLength(0);
  });
});
