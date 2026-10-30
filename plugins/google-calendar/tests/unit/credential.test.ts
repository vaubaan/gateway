/**
 * The scopes Google granted against the ones the plugin asks for: granular
 * consent lets a person untick one and still get a token.
 */
import { describe, expect, test } from 'vitest';

import { REQUIRED_SCOPES, missingScopes, scopesNotGrantedMessage } from '../../src/credential.ts';
import { SCOPES } from '../../src/identity.ts';

const AUTH = 'https://www.googleapis.com/auth/';

describe('missingScopes', () => {
  test('every scope granted: nothing is missing', () => {
    expect(missingScopes([...REQUIRED_SCOPES, 'openid'])).toEqual([]);
  });

  test('scopes not reported: nothing is taken as missing', () => {
    expect(missingScopes([])).toEqual([]);
  });

  test('an unticked scope is missing', () => {
    expect(missingScopes([SCOPES.eventsRead, SCOPES.freeBusy])).toEqual([
      SCOPES.calendarListRead,
      SCOPES.events,
    ]);
  });

  test('a wider scope grants the narrower ones', () => {
    expect(missingScopes([`${AUTH}calendar`])).toEqual([]);
    expect(missingScopes([`${AUTH}calendar.calendarlist`, SCOPES.events, SCOPES.freeBusy])).toEqual(
      [],
    );
  });

  test('the message names what is missing in the gateway’s words', () => {
    expect(scopesNotGrantedMessage([SCOPES.calendarListRead, SCOPES.events])).toBe(
      "Google did not grant every access asked for (missing: see the list of calendars, edit events). Reconnect the account and tick every box on Google's consent screen.",
    );
  });
});
