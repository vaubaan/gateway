import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/policy-engine';

import { envFromSliceSegment } from '../../src/env-of.ts';

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

  test('undefined when the entity is absent, terminal, or spans several envs', () => {
    expect(envOf(parseSlice('vercel.project[prj_1].domain[x].W'), [])).toBeUndefined();
    expect(envOf(parseSlice('vercel.project[prj_1].env.R'), [])).toBeUndefined();
    expect(envOf(parseSlice('vercel.project[prj_1].env[*].env-var[*].R'), [])).toBeUndefined();
    expect(envOf(parseSlice('vercel.project[prj_1].env[prod*].env-var[*].R'), [])).toBeUndefined();
    expect(
      envOf(parseSlice('vercel.project[prj_1].env[prod,preview].env-var[*].R'), []),
    ).toBeUndefined();
  });

  test('does not confuse an identifier equal to the entity name', () => {
    // `[env]` is an ident segment, not the `env` entity.
    expect(envOf(parseSlice('acme.space[env].thing[prod].W'), [])).toBeUndefined();
  });
});
