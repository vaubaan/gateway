import { describe, expect, it } from 'vitest';

import { effectiveResourceEnv, ownResourceEnv } from './resource-env';

describe('effectiveResourceEnv — own label first, the account default next, else none', () => {
  it('keeps an owner label over the default', () => {
    expect(effectiveResourceEnv({ env: 'prod', envSource: 'owner' }, 'staging')).toEqual({
      env: 'prod',
      envSource: 'owner',
    });
  });

  it('never overrides a label the plugin set', () => {
    expect(effectiveResourceEnv({ env: 'live', envSource: 'plugin' }, 'test')).toEqual({
      env: 'live',
      envSource: 'plugin',
    });
  });

  it('gives an unlabelled resource the default, marked as such', () => {
    expect(effectiveResourceEnv({ env: null, envSource: 'owner' }, 'staging')).toEqual({
      env: 'staging',
      envSource: 'account-default',
    });
  });

  it('leaves an unlabelled resource unlabelled when the account has no default', () => {
    expect(effectiveResourceEnv({ env: null, envSource: 'owner' }, null)).toEqual({
      env: null,
      envSource: 'owner',
    });
  });
});

describe('ownResourceEnv', () => {
  it('is the label the resource carries itself, never the inherited one', () => {
    expect(ownResourceEnv({ env: 'staging', envSource: 'account-default' })).toBeNull();
    expect(ownResourceEnv({ env: 'prod', envSource: 'owner' })).toBe('prod');
    expect(ownResourceEnv({ env: 'live', envSource: 'plugin' })).toBe('live');
    expect(ownResourceEnv({ env: null, envSource: 'owner' })).toBeNull();
  });
});
