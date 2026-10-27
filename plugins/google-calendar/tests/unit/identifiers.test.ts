/**
 * The identifier grammars of `google-calendar`, and the proof that a hostile
 * identifier is refused by `classify` and by `execute` alike, before any
 * request (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyGoogleCalendar } from '../../src/classify.ts';
import { executeGoogleCalendar } from '../../src/execute.ts';
import {
  calendarIdOf,
  calendarRefFromArgument,
  calendarRefOf,
  eventId,
  parseAddress,
} from '../../src/identifiers.ts';
import { TOOL } from '../../src/identity.ts';
import { context, primary, team } from './fixtures.ts';

const HOSTILE = ['..', '../x', '%2e%2e', 'a/..', '%2fetc', 'a b', '*', ''];

describe('grammars', () => {
  test('a calendar id and its ref are one to one', () => {
    expect(calendarRefOf('alice@acme.example')).toBe('alice~acme.example');
    expect(calendarIdOf('alice~acme.example')).toBe('alice@acme.example');
    expect(calendarRefFromArgument('c_1@group.calendar.google.com')).toBe(
      'c_1~group.calendar.google.com',
    );
    for (const bad of [
      'en.french#holiday@group.v.calendar.google.com',
      'a+b@x.example',
      'a~b@x.example',
      'nobody',
    ]) {
      expect(calendarRefOf(bad), bad).toBeNull();
    }
  });

  test('an event id is letters, digits, _ and -', () => {
    expect(eventId('7kd8h3j2l1_20261103T100000Z')).toBe('7kd8h3j2l1_20261103T100000Z');
    for (const bad of HOSTILE) expect(eventId(bad), bad).toBeNull();
  });

  test('an address is exactly one address', () => {
    expect(parseAddress(' Bob@Acme.Example ')).toEqual({
      address: 'bob@acme.example',
      domain: 'acme.example',
    });
    for (const bad of [
      'bob',
      'a@b',
      'a@@b.example',
      'a@b.example,c@d.example',
      'a..b@c.example',
      'a@-b.example',
    ]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe('hostile identifiers are refused by classify and by execute', () => {
  test.each(HOSTILE)('eventId %j', async (value) => {
    const args = { eventId: value };
    expect('denied' in classifyGoogleCalendar(TOOL.getEvent, args, [primary, team])).toBe(true);
    const fetch = mockFetch([]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.getEvent, args);
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test.each(HOSTILE)('calendarId %j', async (value) => {
    const args = { calendarId: value };
    expect('denied' in classifyGoogleCalendar(TOOL.listEvents, args, [primary, team])).toBe(true);
    const fetch = mockFetch([]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.listEvents, args);
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});
