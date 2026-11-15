import { describe, expect, it } from 'vitest';

import type { Designation, GroupDesignation } from '../store/repositories/administrators';
import type { GroupRecord } from '../store/types';
import { isOperator, resolveAdministrators, resolveGroupDesignation } from './administrators';

function group(
  name: string,
  signInProvider: string | null,
  source: GroupRecord['source'] = 'idp',
): Pick<GroupRecord, 'name' | 'source' | 'signInProvider'> {
  return { name, source, signInProvider };
}

const base = { grantedBy: 'configuration', origin: 'configuration', createdAt: '' } as const;
const userRow = (userId: string): Designation => ({
  ...base,
  id: `u-${userId}`,
  kind: 'user',
  userId,
});
const emailRow = (email: string, signInProvider: string | null = null): Designation => ({
  ...base,
  id: `e-${email}`,
  kind: 'email',
  email,
  signInProvider,
});
const groupRow = (groupName: string, signInProvider: string | null = null): GroupDesignation => ({
  ...base,
  id: `g-${groupName}`,
  kind: 'group',
  groupName,
  signInProvider,
});

const subject = (
  over: Partial<{
    id: string;
    email: string;
    signInProviderId: string | null;
    groups: Pick<GroupRecord, 'name' | 'source' | 'signInProvider'>[];
  }> = {},
) => ({ id: 'u1', email: 'a@x.test', signInProviderId: 'idp', groups: [], ...over });

describe('administrators', () => {
  it('a user designation names that user only', () => {
    const admins = resolveAdministrators([userRow('u1')], ['idp']);
    expect(isOperator(subject(), admins)).toBe(true);
    expect(isOperator(subject({ id: 'u2' }), admins)).toBe(false);
  });

  it('a designated group of the one sign-in provider names its members, never a local group', () => {
    const admins = resolveAdministrators([groupRow('gateway-admins')], ['idp']);
    expect(
      isOperator(
        subject({ groups: [group('dev', 'idp'), group('gateway-admins', 'idp')] }),
        admins,
      ),
    ).toBe(true);
    expect(isOperator(subject({ groups: [group('dev', 'idp')] }), admins)).toBe(false);
    expect(isOperator(subject({ groups: [group('gateway-admins', null, 'local')] }), admins)).toBe(
      false,
    );
  });

  it('a pending address names its person, case-insensitively, through its sign-in provider or any', () => {
    const any = resolveAdministrators([emailRow('ops@example.com')], ['idp']);
    expect(isOperator(subject({ email: 'OPS@Example.com' }), any)).toBe(true);
    expect(isOperator(subject({ email: 'dev@example.com' }), any)).toBe(false);
    const bound = resolveAdministrators([emailRow('ops@example.com', 'github')], ['idp', 'github']);
    expect(isOperator(subject({ email: 'ops@example.com', signInProviderId: 'idp' }), bound)).toBe(
      false,
    );
    expect(
      isOperator(subject({ email: 'ops@example.com', signInProviderId: 'github' }), bound),
    ).toBe(true);
  });

  it('a group of sign-in provider A never satisfies a designation of sign-in provider B', () => {
    const admins = resolveAdministrators(
      [groupRow('acme/admins', 'github')],
      ['company', 'github'],
    );
    expect(admins.groups).toEqual([{ signInProvider: 'github', name: 'acme/admins' }]);
    expect(isOperator(subject({ groups: [group('acme/admins', 'github')] }), admins)).toBe(true);
    expect(isOperator(subject({ groups: [group('acme/admins', 'company')] }), admins)).toBe(false);
  });

  it('a bare group (carried from the configuration) is ambiguous with several sign-in providers', () => {
    expect(resolveGroupDesignation(groupRow('admins'), ['a', 'b'])).toBeNull();
    expect(resolveGroupDesignation(groupRow('admins'), ['a'])).toEqual({
      signInProvider: 'a',
      name: 'admins',
    });
    // Written with its sign-in provider in the configuration, it resolves with several.
    expect(resolveGroupDesignation(groupRow('github:acme/admins'), ['company', 'github'])).toEqual({
      signInProvider: 'github',
      name: 'acme/admins',
    });
  });

  it('a group naming a removed sign-in provider does not fall to the remaining one', () => {
    expect(resolveGroupDesignation(groupRow('github:acme/admins'), ['company'])).toBeNull();
    expect(resolveGroupDesignation(groupRow('acme/admins', 'github'), ['company'])).toBeNull();
  });

  it('reads a group name with a colon only when written with its sign-in provider', () => {
    expect(resolveGroupDesignation(groupRow('eng:admins'), ['idp'])).toBeNull();
    expect(resolveGroupDesignation(groupRow('idp:eng:admins'), ['idp'])).toEqual({
      signInProvider: 'idp',
      name: 'eng:admins',
    });
  });

  it('with no sign-in provider configured, a bare group names nobody', () => {
    expect(resolveGroupDesignation(groupRow('gateway-admins'), [])).toBeNull();
  });
});
