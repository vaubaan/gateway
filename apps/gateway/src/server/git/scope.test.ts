/**
 * The account a git request reaches (spec §4.1 ter): the path names the
 * repository, hence the account, when the mission carries several accounts of
 * the service whose remote it is.
 */
import type { MissionContext } from '@vaubaan/gateway-core';
import type { RegisteredPlugin } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { targetOf, type Scope } from './scope';

const plugin = {
  id: 'forge',
  gitRemote: { fetchTool: 'forge__git_fetch', pushTool: 'forge__git_push' },
};

function scope(repository: string, accounts: readonly string[]): Scope {
  const ctx = {
    accounts: accounts.map((id) => ({ id, service: 'forge' })),
    // One repository per account: acme/app on the first, acme/web on the second.
    resources: accounts.map((id, index) => ({
      account_id: id,
      ref: index === 0 ? 'acme/app' : 'acme/web',
    })),
  } as unknown as MissionContext;
  return {
    ctx,
    registered: { plugin } as unknown as RegisteredPlugin,
    repository,
    client: {} as Scope['client'],
    agentLabel: null,
    signal: new AbortController().signal,
  };
}

describe('the account of a git request', () => {
  it('is the only account of the service, whatever the repository', () => {
    expect(targetOf(scope('acme/app', ['c-1'])).account.id).toBe('c-1');
  });

  it('is the account holding the repository the path names, case-blind', () => {
    expect(targetOf(scope('acme/web', ['c-1', 'c-2'])).account.id).toBe('c-2');
    expect(targetOf(scope('Acme/App', ['c-1', 'c-2'])).account.id).toBe('c-1');
  });

  it('is never guessed: a repository no account reaches throws (the precheck refused it)', () => {
    expect(() => targetOf(scope('acme/other', ['c-1', 'c-2']))).toThrow(/without its account/);
  });
});
