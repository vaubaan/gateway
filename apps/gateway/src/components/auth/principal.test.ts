import { describe, expect, it } from 'vitest';

import type { Principal } from '@/server/auth';

import { isOperatorPrincipal } from './principal';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;
type BootstrapPrincipal = Extract<Principal, { kind: 'bootstrap' }>;

// Only the two fields the predicate reads matter here.
const user = (isOperator: boolean) => ({ kind: 'user', isOperator }) as UserPrincipal;
const bootstrap = { kind: 'bootstrap' } as BootstrapPrincipal;

describe('isOperatorPrincipal', () => {
  it('is true for the bootstrap token and for a user the admin rule matches', () => {
    expect(isOperatorPrincipal(bootstrap)).toBe(true);
    expect(isOperatorPrincipal(user(true))).toBe(true);
  });

  it('is false for any other user', () => {
    expect(isOperatorPrincipal(user(false))).toBe(false);
  });
});
