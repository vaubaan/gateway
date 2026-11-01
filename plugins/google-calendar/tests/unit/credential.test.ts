/**
 * The scopes Google granted against the ones the plugin asks for: granular
 * consent lets a person untick one and still get a token.
 */
import { describe, expect, test } from 'vitest';

import { REQUIRED_SCOPES, missingScopes, scopesNotGrantedMessage } from '../../src/credential.ts';
import { SCOPES } from '../../src/identity.ts';

const AUTH = 'https://www.googleapis.com/auth/';
/** Scopes a connection made before 0.3.0 holds, and the plugin no longer asks. */
const EVENTS_READ = `${AUTH}calendar.events.readonly`;
const FREE_BUSY = `${AUTH}calendar.events.freebusy`;

describe('missingScopes', () => {
  test('every scope granted: nothing is missing', () => {
    expect(missingScopes([...REQUIRED_SCOPES, 'openid'])).toEqual([]);
  });

  test('scopes not reported: nothing is taken as missing', () => {
    expect(missingScopes([])).toEqual([]);
  });

  test('a connection made before 0.3.0 holds a superset: nothing is missing', () => {
    expect(missingScopes([SCOPES.calendarListRead, EVENTS_READ, FREE_BUSY, SCOPES.events])).toEqual(
      [],
    );
  });

  test('an unticked scope is missing', () => {
    expect(missingScopes([EVENTS_READ, FREE_BUSY])).toEqual([
      SCOPES.calendarListRead,
      SCOPES.events,
    ]);
  });

  test('a wider scope grants the narrower ones', () => {
    expect(missingScopes([`${AUTH}calendar`])).toEqual([]);
    expect(missingScopes([`${AUTH}calendar.calendarlist`, SCOPES.events])).toEqual([]);
  });

  test('the message names what is missing in the gateway’s words', () => {
    expect(scopesNotGrantedMessage([SCOPES.calendarListRead, SCOPES.events])).toBe(
      "Google did not grant every access asked for (missing: see the list of calendars, edit events). Reconnect the account and tick every box on Google's consent screen.",
    );
  });
});
