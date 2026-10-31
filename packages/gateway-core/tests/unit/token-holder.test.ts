/**
 * Who a mission token belongs to (spec §0 "Mission token", §8 "the token used
 * and its holder"): what the audit keeps of the authenticated token, and how a
 * holder is named to a reader.
 */
import { describe, expect, test } from 'vitest';

import {
  MISSION_TOKEN_KINDS,
  isMissionTokenKind,
  tokenAttributionOf,
  tokenHolderLabel,
  type AuthenticatedToken,
} from '../../src/types.ts';

const memberToken: AuthenticatedToken = {
  id: 'tok_1',
  prefix: 'AbCd1234',
  holder: { kind: 'member', user_id: 'usr_bob', display: 'bob@acme.example' },
};
const namedToken: AuthenticatedToken = {
  id: 'tok_2',
  prefix: 'EfGh5678',
  holder: { kind: 'named', name: 'CI runner' },
};

describe('token holder', () => {
  test('the audit keeps the id of a member and the name of a named token', () => {
    expect(tokenAttributionOf(memberToken)).toEqual({
      token_id: 'tok_1',
      token_kind: 'member',
      // The id, not the email: an email can change, the entry is immutable.
      holder: 'usr_bob',
    });
    expect(tokenAttributionOf(namedToken)).toEqual({
      token_id: 'tok_2',
      token_kind: 'named',
      holder: 'CI runner',
    });
  });

  test('a reader is shown the email of a member and the name of a named token', () => {
    expect(tokenHolderLabel(memberToken.holder)).toBe('bob@acme.example');
    expect(tokenHolderLabel(namedToken.holder)).toBe('CI runner');
  });

  test('the two kinds are a closed set', () => {
    expect([...MISSION_TOKEN_KINDS]).toEqual(['member', 'named']);
    expect(isMissionTokenKind('member')).toBe(true);
    expect(isMissionTokenKind('named')).toBe(true);
    for (const other of ['machine', '', null, undefined, 1]) {
      expect(isMissionTokenKind(other)).toBe(false);
    }
  });
});
