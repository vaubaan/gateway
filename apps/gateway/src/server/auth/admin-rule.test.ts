import { describe, expect, it } from 'vitest';

import type { GroupRecord } from '../store/types';
import { describeAdminRule, isOperator, resolveAdminRule } from './admin-rule';

function group(
  name: string,
  provider: string | null,
  source: GroupRecord['source'] = 'idp',
): Pick<GroupRecord, 'name' | 'source' | 'provider'> {
  return { name, source, provider };
}

describe('admin rule', () => {
  const single = resolveAdminRule({ group: 'gateway-admins', emails: [] }, ['idp']);

  it('matches a member of the IdP group of the one provider', () => {
    expect(
      isOperator({ email: 'a@x.test', groups: [group('dev', 'idp'), group('gateway-admins', 'idp')] }, single),
    ).toBe(true);
    expect(isOperator({ email: 'a@x.test', groups: [group('dev', 'idp')] }, single)).toBe(false);
  });

  it('never counts a local group of the same name', () => {
    expect(
      isOperator({ email: 'a@x.test', groups: [group('gateway-admins', null, 'local')] }, single),
    ).toBe(false);
  });

  it('matches a listed email, case-insensitively', () => {
    const rule = resolveAdminRule({ group: null, emails: ['ops@example.com'] }, ['idp']);
    expect(isOperator({ email: 'OPS@Example.com', groups: [] }, rule)).toBe(true);
    expect(isOperator({ email: 'dev@example.com', groups: [] }, rule)).toBe(false);
  });

  it('a group of provider A never satisfies a rule written for provider B', () => {
    const rule = resolveAdminRule({ group: 'github:acme/admins', emails: [] }, ['company', 'github']);
    expect(rule.group).toEqual({ provider: 'github', name: 'acme/admins' });
    expect(isOperator({ email: 'a@x.test', groups: [group('acme/admins', 'github')] }, rule)).toBe(
      true,
    );
    expect(isOperator({ email: 'a@x.test', groups: [group('acme/admins', 'company')] }, rule)).toBe(
      false,
    );
  });

  it('a group without a provider is ambiguous with several providers and matches nobody', () => {
    const rule = resolveAdminRule({ group: 'admins', emails: ['ops@example.com'] }, ['a', 'b']);
    expect(rule.group).toBeNull();
    expect(isOperator({ email: 'x@example.com', groups: [group('admins', 'a')] }, rule)).toBe(false);
    // The emails still work, whatever the provider.
    expect(isOperator({ email: 'ops@example.com', groups: [] }, rule)).toBe(true);
    expect(describeAdminRule(rule)).toContain('names no configured sign-in provider');
  });

  it('a group naming a removed provider does not fall to the remaining one', () => {
    const rule = resolveAdminRule({ group: 'github:acme/admins', emails: [] }, ['company']);
    expect(rule.group).toBeNull();
  });

  it('keeps a legacy group name with a colon for the single provider idp', () => {
    const rule = resolveAdminRule({ group: 'eng:admins', emails: [] }, ['idp']);
    expect(rule.group).toEqual({ provider: 'idp', name: 'eng:admins' });
  });

  it('with no provider configured, reads the rule for the provider idp', () => {
    const rule = resolveAdminRule({ group: 'gateway-admins', emails: [] }, []);
    expect(rule.group).toEqual({ provider: 'idp', name: 'gateway-admins' });
  });

  it('describes the rule without secrets', () => {
    expect(describeAdminRule(single)).toBe(
      'members of the group "gateway-admins" of sign-in provider "idp"',
    );
  });
});
