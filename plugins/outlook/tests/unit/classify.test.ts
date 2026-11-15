/**
 * The classifier of `outlook`, branch by branch: the mailbox of the mission,
 * the sender zones of reads (search bounded by exactly one from:, the worst
 * case of a read by id), the recipient zones of drafts and sends, the
 * calendar writes and the attendees Exchange mails, and every refusal.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyOutlook } from '../../src/classify.ts';
import { SERVICE_ID, TOOL } from '../../src/identity.ts';
import { ACCOUNT, CALENDAR, DRAFT, EVENT, FOLDER, MAILBOX, MESSAGE, mailbox } from './fixtures.ts';

const M = `outlook.mailbox[${MAILBOX}]`;
const at = { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' };
const range = { start: '2026-11-05T08:00:00Z', end: '2026-11-05T18:00:00Z' };

function slices(tool: string, args: Record<string, unknown>, resources: Resource[] = [mailbox]) {
  const out = classifyOutlook(tool, args, resources);
  if ('denied' in out) throw new Error(`denied: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

function denied(tool: string, args: Record<string, unknown>, resources: Resource[] = [mailbox]) {
  const out = classifyOutlook(tool, args, resources);
  if (!('denied' in out))
    throw new Error(`expected a refusal, got ${out.slices.map(serializeSlice).join(' ')}`);
  return out.denied;
}

describe('the mailbox', () => {
  test('omitted, the single one; named by ref or by address', () => {
    expect(slices(TOOL.describeZones, {})).toEqual([`${M}.R`]);
    expect(slices(TOOL.describeZones, { mailbox: MAILBOX })).toEqual([`${M}.R`]);
    expect(slices(TOOL.describeZones, { mailbox: 'Alice@Contoso.example' })).toEqual([`${M}.R`]);
  });

  test('none, several, another one or a malformed one is refused, never substituted', () => {
    expect(denied(TOOL.describeZones, {}, [])).toBe(
      'no Outlook mailbox is a resource of this mission.',
    );
    const other: Resource = { ...mailbox, ref: 'bob~contoso.example' };
    expect(denied(TOOL.listFolders, {}, [mailbox, other])).toMatch(/several mailboxes/);
    expect(slices(TOOL.listFolders, { mailbox: 'bob@contoso.example' }, [mailbox, other])).toEqual([
      'outlook.mailbox[bob~contoso.example].folder[*].R',
    ]);
    expect(denied(TOOL.listFolders, { mailbox: 'bob@contoso.example' })).toMatch(
      /not a mailbox of this mission/,
    );
    expect(denied(TOOL.listFolders, { mailbox: 'a@b@c.example' })).toMatch(/exactly one address/);
    expect(denied(TOOL.listFolders, { mailbox: 7 })).toMatch(/expected a string/);
    const google: Resource = { ...mailbox, service: 'gmail' };
    expect(denied(TOOL.listFolders, {}, [google])).toMatch(/no Outlook mailbox/);
  });

  test('an address the slice grammar cannot carry is classified on every mailbox', () => {
    const plus: Resource = { ...mailbox, ref: 'alice+ops~contoso.example' };
    expect(slices(TOOL.describeZones, {}, [plus])).toEqual(['outlook.mailbox[*].R']);
  });
});

describe('mail reads and who sent them', () => {
  test('one from: address bounds a search to its zone', () => {
    expect(slices(TOOL.searchMessages, { query: 'from:bob@contoso.example is:unread' })).toEqual([
      `${M}.message[*].R`,
      `${M}.from-zone[internal].R`,
    ]);
    expect(slices(TOOL.searchMessages, { query: 'from:noreply@contoso.example' })).toContain(
      `${M}.from-zone[automated].R`,
    );
    expect(slices(TOOL.searchMessages, { query: 'from:dan@partner.example' })).toContain(
      `${M}.from-zone[known-external].R`,
    );
    expect(slices(TOOL.searchMessages, { query: 'from:carol@customer.example invoice' })).toContain(
      `${M}.from-zone[known-external].R`,
    );
    expect(slices(TOOL.searchMessages, { query: 'from:noreply@evil.example' })).toEqual([
      `${M}.message[*].R`,
      `${M}.from-zone[unknown].R`,
    ]);
  });

  test('no from:, two from: or free words alone: unknown and bulk', () => {
    for (const query of [
      '',
      'is:unread',
      'invoice',
      'from:a@x.example from:b@x.example',
      'to:bob@contoso.example',
    ]) {
      expect(slices(TOOL.searchMessages, { query }), query).toEqual([
        `${M}.message[*].R`,
        `${M}.from-zone[unknown].R`,
        `${M}.bulk-marker.R`,
      ]);
    }
  });

  test('a search of Drafts reads drafts too', () => {
    expect(slices(TOOL.searchMessages, { query: 'budget', folder: 'Drafts' })).toContain(
      `${M}.draft[*].R`,
    );
    expect(slices(TOOL.searchMessages, { query: 'budget', folder: 'inbox' })).not.toContain(
      `${M}.draft[*].R`,
    );
  });

  test('a read by id is a read from an unknown sender', () => {
    expect(slices(TOOL.getMessage, { message_id: MESSAGE })).toEqual([
      `${M}.message[${MESSAGE}].R`,
      `${M}.from-zone[unknown].R`,
    ]);
    expect(slices(TOOL.listAttachments, { message_id: MESSAGE })).toEqual([
      `${M}.message[${MESSAGE}].attachment[*].R`,
      `${M}.from-zone[unknown].R`,
    ]);
    expect(slices(TOOL.getAttachment, { message_id: MESSAGE, attachment_id: 'AAMk1' })).toEqual([
      `${M}.message[${MESSAGE}].attachment[AAMk1].R`,
      `${M}.from-zone[unknown].R`,
    ]);
  });

  test('an id with + or = is written [*]: classified on every message', () => {
    expect(slices(TOOL.getMessage, { message_id: 'AAMkAGI2TG93AAA=' })[0]).toBe(
      `${M}.message[*].R`,
    );
  });

  test('folders and drafts', () => {
    expect(slices(TOOL.listFolders, { parent: 'inbox' })).toEqual([`${M}.folder[*].R`]);
    expect(slices(TOOL.listDrafts, {})).toEqual([`${M}.draft[*].R`]);
  });
});

describe('drafts, sends and organisation', () => {
  test('a draft is priced on its worst recipient; outside the allowlists it is refused', () => {
    expect(slices(TOOL.createDraft, { subject: 's', body: 'b' })).toEqual([
      `${M}.draft.W`,
      `${M}.to-zone[self].W`,
    ]);
    expect(
      slices(TOOL.createDraft, {
        to: [ACCOUNT],
        cc: ['bob@contoso.example'],
        subject: 's',
        body: 'b',
      }),
    ).toContain(`${M}.to-zone[internal].W`);
    expect(
      slices(TOOL.createDraft, {
        to: ['bob@contoso.example'],
        bcc: ['dan@partner.example'],
        subject: 's',
        body: 'b',
      }),
    ).toContain(`${M}.to-zone[allowlist].W`);
    expect(
      denied(TOOL.createDraft, {
        to: ['bob@contoso.example'],
        bcc: ['eve@else.example'],
        subject: 's',
        body: 'b',
      }),
    ).toMatch(/not acceptable for a draft/);
  });

  test('a reply draft: the declared recipients, at least one To', () => {
    expect(
      slices(TOOL.createReplyDraft, {
        message_id: MESSAGE,
        body: 'ok',
        to: ['carol@customer.example'],
        reply_all: true,
      }),
    ).toEqual([`${M}.draft.W`, `${M}.to-zone[allowlist].W`]);
    expect(denied(TOOL.createReplyDraft, { message_id: MESSAGE, body: 'ok', to: [] })).toMatch(
      /at least one/,
    );
    expect(
      denied(TOOL.createReplyDraft, { message_id: MESSAGE, body: 'ok', to: ['eve@else.example'] }),
    ).toMatch(/not acceptable/);
    expect(
      denied(TOOL.createReplyDraft, { message_id: '../x', body: 'ok', to: [ACCOUNT] }),
    ).toMatch(/Graph id/);
  });

  test('a send is priced on its worst recipient, external included', () => {
    const send = (to: string[]) => slices(TOOL.sendMessage, { to, subject: 's', body: 'b' });
    expect(send([ACCOUNT])).toEqual([`${M}.send-zone[self].W`]);
    expect(send(['bob@contoso.example'])).toEqual([`${M}.send-zone[internal].W`]);
    expect(send(['bob@contoso.example', 'carol@customer.example'])).toEqual([
      `${M}.send-zone[allowlist].W`,
    ]);
    expect(send(['eve@else.example'])).toEqual([`${M}.send-zone[external-unbounded].W`]);
    expect(slices(TOOL.sendDraft, { draft_id: DRAFT, to: ['bob@contoso.example'] })).toEqual([
      `${M}.send-zone[internal].W`,
    ]);
  });

  test('a send needs a recipient, at most 100, each exactly one address', () => {
    expect(denied(TOOL.sendMessage, { subject: 's', body: 'b' })).toMatch(/at least one recipient/);
    const many = Array.from({ length: 101 }, (_, i) => `p${i}@contoso.example`);
    expect(denied(TOOL.sendMessage, { to: many, subject: 's', body: 'b' })).toMatch(/at most 100/);
    for (const bad of [
      'bob',
      'Bob <bob@contoso.example>',
      'a@b.example,c@d.example',
      'a..b@c.example',
    ]) {
      expect(denied(TOOL.sendMessage, { to: [bad], subject: 's', body: 'b' }), bad).toMatch(
        /not exactly one e-mail address/,
      );
    }
    expect(
      denied(TOOL.sendMessage, { to: 'bob@contoso.example', subject: 's', body: 'b' }),
    ).toMatch(/to: expected array/);
  });

  test('moves, updates and folders', () => {
    expect(slices(TOOL.moveMessage, { message_id: MESSAGE, folder: 'Archive' })).toEqual([
      `${M}.message[${MESSAGE}].W`,
    ]);
    for (const folder of [
      'deleteditems',
      'DeletedItems',
      'junkemail',
      'recoverableitemsdeletions',
      'outbox',
    ]) {
      expect(denied(TOOL.moveMessage, { message_id: MESSAGE, folder }), folder).toMatch(
        /not offered/,
      );
    }
    expect(slices(TOOL.updateMessage, { message_id: MESSAGE, categories: ['Red'] })).toEqual([
      `${M}.message[${MESSAGE}].W`,
    ]);
    expect(denied(TOOL.updateMessage, { message_id: MESSAGE })).toMatch(
      /give is_read, flag or categories/,
    );
    expect(denied(TOOL.updateMessage, { message_id: MESSAGE, flag: 'urgent' })).toMatch(
      /expected one of/,
    );
    expect(denied(TOOL.updateMessage, { message_id: MESSAGE, categories: ['a\nb'] })).toMatch(
      /categories\[0\]/,
    );
    expect(slices(TOOL.createFolder, { name: 'Clients', parent: FOLDER })).toEqual([
      `${M}.folder.W`,
    ]);
    expect(denied(TOOL.createFolder, { name: '  ' })).toMatch(/name/);
    expect(denied(TOOL.createFolder, { name: 'x', parent: 'a/b' })).toMatch(
      /well-known folder name/,
    );
  });
});

describe('the search grammar is closed', () => {
  test.each([
    'from:a@x.example OR from:b@x.example',
    '-from:a@x.example',
    '"quoted phrase"',
    '(budget)',
    'label:legal',
    'is:read',
    'has:link',
    'budget*',
    'NOT budget',
    'subject:a"b',
    'after:2026-13-01',
    'from:bob',
  ])('%j is refused', (query) => {
    expect(denied(TOOL.searchMessages, { query })).toMatch(/query:/);
  });
});

describe('calendar', () => {
  test('reads', () => {
    expect(slices(TOOL.listCalendars, {})).toEqual(['outlook.calendar[*].R']);
    expect(slices(TOOL.listEvents, range)).toEqual(['outlook.calendar[default].event[*].R']);
    expect(slices(TOOL.listEvents, { ...range, calendar: CALENDAR })).toEqual([
      `outlook.calendar[${CALENDAR}].event[*].R`,
    ]);
    expect(slices(TOOL.searchEvents, { text: 'review' })).toEqual([
      'outlook.calendar[default].event[*].R',
    ]);
    expect(slices(TOOL.getEvent, { event_id: EVENT })).toEqual([
      `outlook.calendar[default].event[${EVENT}].R`,
    ]);
    expect(slices(TOOL.suggestTime, { attendees: ['zoe@else.example'], ...range })).toEqual([
      'outlook.free-busy.R',
    ]);
  });

  test('who is invited decides the guest zones; oneself reaches nobody', () => {
    expect(slices(TOOL.createEvent, { subject: 'x', ...at, attendees: [ACCOUNT] })).toEqual([
      'outlook.calendar[default].event.W',
    ]);
    expect(
      slices(TOOL.createEvent, {
        subject: 'x',
        ...at,
        attendees: ['bob@contoso.example', 'carol@customer.example'],
      }),
    ).toEqual([
      'outlook.calendar[default].event.W',
      'outlook.calendar[default].guests[external].W',
      'outlook.calendar[default].guests[internal].W',
    ]);
  });

  test('every update and deletion lets Exchange mail the attendees', () => {
    const e = `outlook.calendar[default].event[${EVENT}]`;
    expect(slices(TOOL.updateEvent, { event_id: EVENT, subject: 'Moved' })).toEqual([
      `${e}.W`,
      `${e}.notify.W`,
    ]);
    expect(
      slices(TOOL.updateEvent, { event_id: EVENT, added_attendees: ['dan@partner.example'] }),
    ).toEqual([`${e}.W`, 'outlook.calendar[default].guests[external].W', `${e}.notify.W`]);
    expect(slices(TOOL.deleteEvent, { event_id: EVENT })).toEqual([
      `${e}.delete.W`,
      `${e}.notify.W`,
    ]);
    expect(
      slices(TOOL.respondToEvent, { event_id: EVENT, response: 'decline', send_response: true }),
    ).toEqual([`${e}.response.W`]);
  });

  test('times: instants with an offset, or local date-times with time_zone', () => {
    expect(
      slices(TOOL.createEvent, {
        subject: 'x',
        start: '2026-11-05T10:00',
        end: '2026-11-05T11:00',
        time_zone: 'Europe/Paris',
      }),
    ).toEqual(['outlook.calendar[default].event.W']);
    expect(
      denied(TOOL.createEvent, {
        subject: 'x',
        start: '2026-11-05T10:00',
        end: '2026-11-05T11:00',
      }),
    ).toMatch(/RFC 3339/);
    expect(denied(TOOL.createEvent, { subject: 'x', ...at, time_zone: 'Europe/Paris' })).toMatch(
      /local date-times/,
    );
    expect(denied(TOOL.createEvent, { subject: 'x', start: at.end, end: at.start })).toMatch(
      /after start/,
    );
    expect(denied(TOOL.createEvent, { subject: 'x', start: at.start })).toMatch(/end: required/);
    expect(denied(TOOL.updateEvent, { event_id: EVENT, start: at.start })).toMatch(
      /both or neither/,
    );
    expect(denied(TOOL.updateEvent, { event_id: EVENT, time_zone: 'UTC' })).toMatch(/time_zone/);
    expect(denied(TOOL.updateEvent, { event_id: EVENT })).toMatch(/nothing to change/);
    expect(
      denied(TOOL.createEvent, {
        subject: 'x',
        start: '2026-11-05T25:00',
        end: '2026-11-05T26:00',
        time_zone: 'UTC',
      }),
    ).toMatch(/local date-times/);
    expect(denied(TOOL.createEvent, { subject: 'x', ...at, time_zone: 'Paris; drop' })).toMatch(
      /time_zone/,
    );
  });

  test('ranges and bounds', () => {
    expect(denied(TOOL.listEvents, {})).toMatch(/start: required/);
    expect(denied(TOOL.listEvents, { start: 'today', end: 'tomorrow' })).toMatch(/RFC 3339/);
    expect(denied(TOOL.listEvents, { start: range.end, end: range.start })).toMatch(/after start/);
    expect(denied(TOOL.listEvents, { ...range, top: 251 })).toMatch(/at most 250/);
    expect(denied(TOOL.searchEvents, { text: 'x', start: range.start })).toMatch(/give both/);
    expect(denied(TOOL.searchEvents, { text: '' })).toMatch(/text:/);
    expect(denied(TOOL.suggestTime, { attendees: [], ...range })).toMatch(/1 to 20/);
    expect(slices(TOOL.suggestTime, { attendees: [ACCOUNT], ...range })).toEqual([
      'outlook.free-busy.R',
    ]);
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@contoso.example`);
    expect(denied(TOOL.suggestTime, { attendees: many, ...range })).toMatch(/1 to 20/);
    expect(
      denied(TOOL.suggestTime, { attendees: ['a@b.example'], ...range, duration_minutes: 2 }),
    ).toMatch(/at least 5/);
    expect(denied(TOOL.respondToEvent, { event_id: EVENT, response: 'maybe' })).toMatch(
      /expected one of accept/,
    );
  });

  test('a calendar or an event outside its grammar', () => {
    expect(denied(TOOL.listEvents, { ...range, calendar: 'a/b' })).toMatch(
      /calendar: expected "default"/,
    );
    expect(denied(TOOL.getEvent, { event_id: 'x?y' })).toMatch(/event_id: expected a Graph id/);
    expect(denied(TOOL.getEvent, {})).toMatch(/event_id: required/);
  });
});

describe('refusals of the argument surface', () => {
  test('unknown tool, undeclared argument, ill-typed argument', () => {
    expect(denied('outlook__delete_message', {})).toMatch(/unknown tool/);
    expect(denied(TOOL.getMessage, { message_id: MESSAGE, select: 'body' })).toMatch(/select/);
    expect(denied(TOOL.getMessage, { message_id: MESSAGE, $select: 'body' })).toMatch(
      /malformed name/,
    );
    expect(
      denied(TOOL.sendMessage, { to: [ACCOUNT], subject: 's', body: 'b', saveToSentItems: false }),
    ).toMatch(/saveToSentItems/);
    expect(denied(TOOL.searchMessages, { query: 'x', top: 51 })).toMatch(/at most 50/);
    expect(denied(TOOL.searchMessages, { query: 'x', top: '5' })).toMatch(/top: expected integer/);
    expect(denied(TOOL.createDraft, { subject: 'a\nb', body: 'b' })).toMatch(/subject/);
    expect(denied(TOOL.createDraft, { subject: 's' })).toMatch(/body: required/);
  });

  test('the service id is the first segment of every slice', () => {
    for (const s of slices(TOOL.sendMessage, { to: [ACCOUNT], subject: 's', body: 'b' })) {
      expect(s.startsWith(`${SERVICE_ID}.`)).toBe(true);
    }
  });
});
