/**
 * `trust_raise.after_approvals` (risk model §4.7): how many approvals granted on one
 * macro-action of one resource set before a raise is offered. Default 10, a whole
 * number >= 1.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import { validEnv } from '../../../tests/support/config/testing';

describe('trust_raise.after_approvals', () => {
  it('is 10 when absent', () => {
    const { config } = loadInstanceConfig({ env: validEnv() });
    expect(config.trustRaise).toEqual({ afterApprovals: 10 });
  });

  it('reads the environment', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_TRUST_RAISE_AFTER_APPROVALS: '3' }),
    });
    expect(config.trustRaise.afterApprovals).toBe(3);
  });

  it('refuses zero and a fraction', () => {
    for (const value of ['0', '2.5']) {
      expect(() =>
        loadInstanceConfig({ env: validEnv({ VAUBAAN_TRUST_RAISE_AFTER_APPROVALS: value }) }),
      ).toThrow(ConfigError);
    }
  });
});
