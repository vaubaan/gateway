import { describe, expect, test } from 'vitest';

import { envResolverFor, parseSlice } from '@vaubaan/policy-engine';

import { envFromSliceSegment, NO_SINGLE_ENV } from '../../src/env-of.ts';

const envOf = envFromSliceSegment('env');

describe('envFromSliceSegment', () => {
  test('reads the identifier that follows the named entity', () => {
    expect(envOf(parseSlice('vercel.project[prj_1].env[prod].env-var[API_KEY].W'), [])).toBe(
      'prod',
    );
    expect(envOf(parseSlice('vercel.project[prj_1].env[preview].deployment[*].R'), [])).toBe(
      'preview',
    );
  });

  test('undefined when the entity is absent, terminal, or followed by another entity', () => {
    expect(envOf(parseSlice('vercel.project[prj_1].domain[x].W'), [])).toBeUndefined();
    expect(envOf(parseSlice('vercel.project[prj_1].env.R'), [])).toBeUndefined();
    expect(envOf(parseSlice('vercel.project[prj_1].env.settings.R'), [])).toBeUndefined();
  });

  test.each([
    ['a wildcard', 'vercel.project[prj_1].env[*].env-var[*].R'],
    ['a recursive wildcard', 'vercel.project[prj_1].env[**].R'],
    ['a glob', 'vercel.project[prj_1].env[prod*].env-var[*].R'],
    ['a list', 'vercel.project[prj_1].env[prod,preview].env-var[*].R'],
  ])('NO_SINGLE_ENV when the environment is %s: the label must not stand in', (_what, slice) => {
    expect(envOf(parseSlice(slice), [])).toBe(NO_SINGLE_ENV);
  });

  test('composed by the host, a slice spanning several environments resolves to none', () => {
    // The resource is labelled `staging`; the slice reaches every environment of it.
    const labelled = [{ provider: 'vercel', ref: 'prj_1', env: 'staging', displayName: 'app' }];
    const resolver = envResolverFor(labelled, envOf);
    expect(resolver.resolveEnv(parseSlice('vercel.project[prj_1].env[*].env-var[K].W'))).toBeNull();
    expect(
      resolver.resolveEnv(parseSlice('vercel.project[prj_1].env[prod,preview].env-var[K].W')),
    ).toBeNull();
    // An env-less slice still takes the label.
    expect(resolver.resolveEnv(parseSlice('vercel.project[prj_1].domain[x].W'))).toBe('staging');
  });

  test('does not confuse an identifier equal to the entity name', () => {
    // `[env]` is an ident segment, not the `env` entity.
    expect(envOf(parseSlice('acme.space[env].thing[prod].W'), [])).toBeUndefined();
  });
});
