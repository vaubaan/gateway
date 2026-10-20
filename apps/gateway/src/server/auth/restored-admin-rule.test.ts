import { describe, expect, it } from 'vitest';

import { parseRestoredAdminRule, serializeRestoredAdminRule } from './restored-admin-rule';

describe('the admin rule a backup carried', () => {
  it('round-trips, and refuses what does not parse', () => {
    const rule = { group: 'entra:admins', emails: ['a@x.example'] };
    expect(parseRestoredAdminRule(serializeRestoredAdminRule(rule))).toEqual(rule);
    expect(parseRestoredAdminRule(null)).toBeNull();
    expect(parseRestoredAdminRule('not json')).toBeNull();
    expect(parseRestoredAdminRule('{"group":3,"emails":[]}')).toBeNull();
    expect(parseRestoredAdminRule('{"group":null,"emails":"a"}')).toBeNull();
  });
});
