/**
 * The Graph permissions Microsoft granted against the ones the plugin asks
 * for: a person (or a tenant policy) may grant fewer.
 */
import { describe, expect, test } from 'vitest';

import {
  REQUIRED_PERMISSIONS,
  missingScopes,
  scopesNotGrantedMessage,
} from '../../src/credential.ts';
import { SCOPES } from '../../src/identity.ts';

describe('missingScopes', () => {
  test('every permission granted, OpenID scopes ignored', () => {
    expect(missingScopes([...REQUIRED_PERMISSIONS])).toEqual([]);
    expect(missingScopes(['openid', 'profile', ...REQUIRED_PERMISSIONS])).toEqual([]);
  });

  test('not reported: nothing is taken as missing', () => {
    expect(missingScopes([])).toEqual([]);
  });

  test('case-insensitive, the Graph resource prefix tolerated', () => {
    expect(
      missingScopes([
        'https://graph.microsoft.com/User.Read',
        'https://graph.microsoft.com/mail.readwrite',
        'MAIL.SEND',
        'calendars.readwrite',
      ]),
    ).toEqual([]);
  });

  test('a permission not granted is missing; OpenID scopes alone grant none', () => {
    expect(missingScopes(['openid', 'email', 'offline_access'])).toEqual([...REQUIRED_PERMISSIONS]);
    expect(missingScopes(['User.Read', 'Mail.ReadWrite', 'Calendars.ReadWrite'])).toEqual([
      SCOPES.mailSend,
    ]);
    expect(missingScopes(['User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite'])).toEqual([
      SCOPES.mailReadWrite,
    ]);
  });

  test('the message names what is missing in the gateway’s words', () => {
    expect(scopesNotGrantedMessage([SCOPES.mailSend])).toBe(
      'Microsoft did not grant every access asked for (missing: send mail as you). Reconnect the account and accept every permission; an administrator of the organisation may have to consent first.',
    );
  });
});
