/**
 * Secret arguments in the approval view (`maskSecretArguments`): the values a
 * plugin declares secret are shown as a fingerprint, the keys stay, every
 * other argument is shown as it is.
 */
import { createHash } from 'node:crypto';

import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { maskSecretArguments, maskedValue } from '../../../../src/server/requests/masked-arguments';

const registry = {
  get: (id: string) =>
    id === 'fly'
      ? { plugin: { secretArguments: { fly__set_secrets: ['values'] } } }
      : id === 'acme'
        ? { plugin: {} }
        : undefined,
} as unknown as Pick<PluginRegistry, 'get'>;

describe('maskSecretArguments', () => {
  it('masks every value of a secret object argument and keeps the names', () => {
    const shown = maskSecretArguments(registry, 'fly__set_secrets', {
      app: 'acme-gw',
      values: { VAUBAAN_MASTER_KEY: 's3cret', OTHER: '' },
    });
    expect(shown).toEqual({
      app: 'acme-gw',
      values: { VAUBAAN_MASTER_KEY: maskedValue('s3cret'), OTHER: maskedValue('') },
    });
    expect(JSON.stringify(shown)).not.toContain('s3cret');
  });

  it('the fingerprint is the start of the value SHA-256, enough to compare, not to read', () => {
    const digest = createHash('sha256').update('s3cret').digest('hex');
    expect(maskedValue('s3cret')).toBe(`[secret · sha256:${digest.slice(0, 12)}]`);
    expect(maskedValue('a')).not.toBe(maskedValue('b'));
  });

  it('masks strings nested in lists and objects, keeps other scalars', () => {
    expect(
      maskSecretArguments(registry, 'fly__set_secrets', {
        values: { list: ['x', 1, true, null], nested: { deep: 'y' } },
      }),
    ).toEqual({
      values: {
        list: [maskedValue('x'), 1, true, null],
        nested: { deep: maskedValue('y') },
      },
    });
  });

  it('leaves the arguments of other tools, plugins without masks and unknown tools as they are', () => {
    const args = { app: 'acme-gw', name: 'X' };
    expect(maskSecretArguments(registry, 'fly__unset_secret', args)).toBe(args);
    expect(maskSecretArguments(registry, 'acme__do', args)).toBe(args);
    expect(maskSecretArguments(registry, 'nope__do', args)).toBe(args);
    expect(maskSecretArguments(registry, 'malformed', args)).toBe(args);
    expect(maskSecretArguments(registry, 'fly__set_secrets', null)).toBeNull();
  });
});
