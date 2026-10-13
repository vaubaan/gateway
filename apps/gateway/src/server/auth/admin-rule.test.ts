import { describe, expect, it } from 'vitest';

import { describeAdminRule, isOperator } from './admin-rule';

describe('isOperator (admin rule)', () => {
  it('matches a member of the configured IdP group', () => {
    const rule = { group: 'gateway-admins', emails: [] };
    expect(isOperator({ email: 'a@x.test', groupNames: ['dev', 'gateway-admins'] }, rule)).toBe(
      true,
    );
    expect(isOperator({ email: 'a@x.test', groupNames: ['dev'] }, rule)).toBe(false);
  });
  it('matches a listed email, case-insensitively', () => {
    const rule = { group: null, emails: ['ops@example.com'] };
    expect(isOperator({ email: 'OPS@Example.com', groupNames: [] }, rule)).toBe(true);
    expect(isOperator({ email: 'dev@example.com', groupNames: [] }, rule)).toBe(false);
  });
  it('matches neither when the user is in no admin group and not listed', () => {
    const rule = { group: 'gateway-admins', emails: ['ops@example.com'] };
    expect(isOperator({ email: 'dev@example.com', groupNames: ['dev'] }, rule)).toBe(false);
  });
  it('is true when either half of a combined rule matches', () => {
    const rule = { group: 'gateway-admins', emails: ['ops@example.com'] };
    expect(isOperator({ email: 'ops@example.com', groupNames: [] }, rule)).toBe(true);
    expect(isOperator({ email: 'x@example.com', groupNames: ['gateway-admins'] }, rule)).toBe(true);
  });
  it('describes the rule without secrets', () => {
    expect(describeAdminRule({ group: 'g', emails: ['a@b', 'c@d'] })).toBe(
      'members of the IdP group "g" or 2 listed email(s)',
    );
    expect(describeAdminRule({ group: null, emails: ['a@b'] })).toBe('1 listed email(s)');
  });
});
