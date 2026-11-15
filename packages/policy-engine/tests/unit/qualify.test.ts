/**
 * Unit tests for the RiskId qualify / unqualify helpers.
 *
 * Mirrors and supersedes the older copy in
 * `apps/gateway/tests/unit/lib/risk-catalog/loader.test.ts` (the loader now
 * re-exports from `@vaubaan/policy-engine`).
 *
 * The "round-trip" tests are the load-bearing ones : if `qualifyRiskId`
 * and `unqualifyRiskId` ever drift apart (e.g. the bracket regex tightens
 * on one side and not the other), set-membership checks at the runtime
 * silently break.
 */
import { describe, expect, test } from 'vitest';
import type { Resource, RiskEntry, RiskId } from '@vaubaan/shared';
import { parseSlice } from '../../src/slice-dsl.ts';

import {
  envResolverFor,
  isEnvScopedEntry,
  NO_SINGLE_ENV,
  noEnvResolver,
  qualifyRiskId,
  resolveVector,
  resourceEnvResolver,
  unqualifyRiskId,
  type EnvDeriver,
} from '../../src/qualify.ts';

const envScopedEntry: RiskEntry = {
  id: 'supabase.bulk-row-write',
  label: 'bulk',
  reason: 'bulk',
  matches: 'supabase.project[**].schema[**].table[**].row[*].W',
  vector: {
    reversibility: 'costly',
    blast: 'bulk',
    data: 'data',
    cost: 'moderate',
    visibility: 'internal',
  },
  acceptable_in_envs: ['staging', 'preview'],
};

const accountScopedEntry: RiskEntry = {
  id: 'github.mint-install-token',
  label: 'mint',
  reason: 'mint',
  matches: 'github.repo[**].install-token[**].W',
  vector: {
    reversibility: 'reversible',
    blast: 'account',
    data: 'secret',
    cost: 'free',
    visibility: 'internal',
  },
};

describe('isEnvScopedEntry', () => {
  test('true when acceptable_in_envs is non-empty', () => {
    expect(isEnvScopedEntry(envScopedEntry)).toBe(true);
  });
  test('false when acceptable_in_envs is absent or empty', () => {
    expect(isEnvScopedEntry(accountScopedEntry)).toBe(false);
    expect(isEnvScopedEntry({ ...envScopedEntry, acceptable_in_envs: [] })).toBe(false);
  });
  test('false when entry is undefined', () => {
    expect(isEnvScopedEntry(undefined)).toBe(false);
  });
});

describe('qualifyRiskId', () => {
  test('returns base id when env is null or empty', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', null, envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', '', envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', undefined, envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
  });

  test('injects [env] before the first dot for env-scoped risks', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[prod].bulk-row-write',
    );
  });

  test('does not qualify account-scoped risks', () => {
    expect(qualifyRiskId('github.mint-install-token', 'prod', accountScopedEntry)).toBe(
      'github.mint-install-token',
    );
  });

  test('leaves already-qualified ids alone (defensive double-qualify)', () => {
    expect(qualifyRiskId('supabase[staging].bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
  });

  test('returns base id when entry is undefined', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', undefined)).toBe(
      'supabase.bulk-row-write',
    );
  });
});

describe('unqualifyRiskId', () => {
  test('strips [env] when present', () => {
    expect(unqualifyRiskId('supabase[staging].bulk-row-write')).toBe('supabase.bulk-row-write');
    expect(unqualifyRiskId('vercel[prod].env-var-write')).toBe('vercel.env-var-write');
  });
  test('leaves non-qualified ids unchanged', () => {
    expect(unqualifyRiskId('github.mint-install-token')).toBe('github.mint-install-token');
    expect(unqualifyRiskId('supabase.read-data')).toBe('supabase.read-data');
  });
});

describe('qualify / unqualify round-trip', () => {
  const ids: ReadonlyArray<[RiskId, string]> = [
    ['supabase.bulk-row-write', 'staging'],
    ['supabase.bulk-row-write', 'prod'],
    ['vercel.env-var-write', 'production'],
    ['vercel.env-var-write', 'preview'],
  ];

  for (const [base, env] of ids) {
    test(`unqualify(qualify(${base}, ${env})) === ${base}`, () => {
      const qualified = qualifyRiskId(base, env, envScopedEntry);
      expect(unqualifyRiskId(qualified)).toBe(base);
    });
  }

  test('account-scoped id stays untouched through both ops', () => {
    const base: RiskId = 'github.mint-install-token';
    const qualified = qualifyRiskId(base, 'prod', accountScopedEntry);
    expect(qualified).toBe(base);
    expect(unqualifyRiskId(qualified)).toBe(base);
  });
});

describe('resourceEnvResolver', () => {
  const staging: Resource = {
    service: 'supabase',
    ref: 'stg-ref',
    env: 'staging',
    displayName: 'Staging',
  };
  const prod: Resource = { service: 'supabase', ref: 'prd-ref', env: 'prod', displayName: 'Prod' };
  const unlabelled: Resource = { service: 'github', ref: 'acme/app', displayName: 'acme/app' };

  test('two identifiers that name resources of different environments: no environment', () => {
    // The resolver cannot know which segment is the resource. An identifier a caller
    // chose (a table, a key, a branch) that equals the ref of another resource must not
    // lend that resource's label to the call: the refs disagree, so nothing is resolved
    // and an env-scoped risk is refused.
    const r = resourceEnvResolver([staging, prod]);
    expect(
      r.resolveEnv(parseSlice('supabase.project[prd-ref].schema[public].table[stg-ref].W')),
    ).toBeNull();
    expect(
      r.resolveEnv(parseSlice('supabase.schema[stg-ref].project[prd-ref].table[t].W')),
    ).toBeNull();
    expect(r.resolveEnv(parseSlice('supabase.project[stg-ref,prd-ref].table[t].W'))).toBeNull();
  });

  test('several identifiers that name resources of ONE environment keep it', () => {
    const other: Resource = { ...staging, ref: 'stg-2' };
    const r = resourceEnvResolver([staging, other, prod]);
    expect(r.resolveEnv(parseSlice('supabase.project[stg-ref,stg-2].table[t].R'))).toBe('staging');
    expect(r.resolveEnv(parseSlice('supabase.project[stg-ref].copy[stg-ref].R'))).toBe('staging');
  });

  test('a labelled and an unlabelled resource cited together: no environment', () => {
    const bare: Resource = { service: 'supabase', ref: 'bare-ref', displayName: 'Bare' };
    const r = resourceEnvResolver([staging, bare]);
    expect(r.resolveEnv(parseSlice('supabase.project[stg-ref].table[bare-ref].W'))).toBeNull();
  });

  test('matches the ident segment equal to a resource ref', () => {
    const r = resourceEnvResolver([staging, prod]);
    expect(
      r.resolveEnv(parseSlice('supabase.project[prd-ref].schema[public].table[t].row[*].W')),
    ).toBe('prod');
    expect(
      r.resolveEnv(parseSlice('supabase.project[stg-ref].schema[public].table[t].row[*].W')),
    ).toBe('staging');
  });

  test('null when the slice service has no resource', () => {
    expect(
      resourceEnvResolver([staging]).resolveEnv(parseSlice('vercel.project[x].deployment[*].W')),
    ).toBeNull();
  });

  test('falls back to the single resource env when the path carries no ref', () => {
    expect(resourceEnvResolver([prod]).resolveEnv(parseSlice('supabase.account.R'))).toBe('prod');
  });

  test('ambiguous (several resources, no ref in path) → null', () => {
    expect(
      resourceEnvResolver([staging, prod]).resolveEnv(parseSlice('supabase.account.R')),
    ).toBeNull();
  });

  test('unlabelled resource resolves to null even when matched', () => {
    expect(
      resourceEnvResolver([unlabelled]).resolveEnv(
        parseSlice('github.repo[acme/app].branch[main].W'),
      ),
    ).toBeNull();
  });

  test('noEnvResolver never qualifies', () => {
    expect(noEnvResolver.resolveEnv(parseSlice('supabase.project[prd-ref].R'))).toBeNull();
  });
});

describe('envResolverFor — plugin-derived env first, resource label next, else null', () => {
  // ADR fallback-risk-only-when-uncategorized, § environment resolution ;
  // spec vaubaan-gateway §0 "Resource".

  /** Vercel-like deriver : the environment is the `env[<label>]` slice segment. */
  const vercelEnvOf: EnvDeriver = (slice) => {
    const i = slice.path.findIndex((seg) => seg.kind === 'name' && seg.value === 'env');
    const next = i >= 0 ? slice.path[i + 1] : undefined;
    return next?.kind === 'ident' ? next.value : undefined;
  };

  test('Vercel-like : the slice segment wins over the resource label (or its absence)', () => {
    const project: Resource = {
      service: 'vercel',
      ref: 'prj_1',
      displayName: 'gateway',
      env: 'staging', // an owner label that would be wrong for a prod env-var write
    };
    const resolver = envResolverFor([project], vercelEnvOf);
    expect(
      resolver.resolveEnv(parseSlice('vercel.project[prj_1].env[prod].env-var[API_KEY].W')),
    ).toBe('prod');
    expect(
      resolver.resolveEnv(parseSlice('vercel.project[prj_1].env[preview].deployment[*].R')),
    ).toBe('preview');
    // No env segment → the label applies.
    expect(resolver.resolveEnv(parseSlice('vercel.project[prj_1].domain[x].W'))).toBe('staging');
    // Unlabelled resource and no env segment → unqualified.
    const unlabelled: Resource = { service: 'vercel', ref: 'prj_1', displayName: 'gateway' };
    expect(
      envResolverFor([unlabelled], vercelEnvOf).resolveEnv(
        parseSlice('vercel.project[prj_1].domain[x].W'),
      ),
    ).toBeNull();
  });

  test('Supabase-like : no plugin hook, the owner label on the matching resource applies', () => {
    const resources: Resource[] = [
      { service: 'supabase', ref: 'abc', env: 'prod', displayName: 'prod db' },
      { service: 'supabase', ref: 'def', env: 'staging', displayName: 'staging db' },
    ];
    const resolver = envResolverFor(resources);
    expect(
      resolver.resolveEnv(parseSlice('supabase.project[def].schema[public].table[t].row[*].W')),
    ).toBe('staging');
    expect(
      resolver.resolveEnv(parseSlice('supabase.project[abc].schema[public].table[t].row[*].W')),
    ).toBe('prod');
    // Two resources, no ref in the path → ambiguous → null.
    expect(resolver.resolveEnv(parseSlice('supabase.account.R'))).toBeNull();
  });

  test('Stripe-like : the plugin labelled one resource per mode at discovery ; a hook that defers lets the label through', () => {
    const resources: Resource[] = [
      { service: 'stripe', ref: 'acct_1/test', env: 'test', displayName: 'Acme (test)' },
      { service: 'stripe', ref: 'acct_1/live', env: 'live', displayName: 'Acme (live)' },
    ];
    const defers: EnvDeriver = () => undefined;
    const resolver = envResolverFor(resources, defers);
    expect(resolver.resolveEnv(parseSlice('stripe.account[acct_1/live].customer[cus_1].W'))).toBe(
      'live',
    );
    expect(resolver.resolveEnv(parseSlice('stripe.account[acct_1/test].customer[cus_1].W'))).toBe(
      'test',
    );
  });

  test('an empty string or null from the hook defers to the label', () => {
    const resources: Resource[] = [{ service: 'x', ref: 'r', env: 'prod', displayName: 'r' }];
    expect(envResolverFor(resources, () => '').resolveEnv(parseSlice('x.thing[r].W'))).toBe('prod');
    expect(envResolverFor(resources, () => null).resolveEnv(parseSlice('x.thing[r].W'))).toBe(
      'prod',
    );
  });

  test('NO_SINGLE_ENV from the hook: no environment, and the label does not stand in', () => {
    // The slice names its environment, but not exactly one (`env[*]`, `env[prod,preview]`).
    // Falling back to the owner's label would price a call that reaches `prod` as `staging`.
    const resources: Resource[] = [{ service: 'x', ref: 'r', env: 'staging', displayName: 'r' }];
    const resolver = envResolverFor(resources, () => NO_SINGLE_ENV);
    expect(resolver.resolveEnv(parseSlice('x.thing[r].env[*].var[K].W'))).toBeNull();
  });

  test('without a hook it is exactly resourceEnvResolver', () => {
    const resources: Resource[] = [{ service: 'x', ref: 'r', env: 'prod', displayName: 'r' }];
    const slice = parseSlice('x.thing[r].W');
    expect(envResolverFor(resources).resolveEnv(slice)).toBe(
      resourceEnvResolver(resources).resolveEnv(slice),
    );
  });
});

describe('resolveVector', () => {
  const entry: Pick<RiskEntry, 'vector' | 'vector_overrides'> = {
    vector: envScopedEntry.vector,
    vector_overrides: { prod: { reversibility: 'irreversible', visibility: 'public' } },
  };

  test('the override of the env replaces its axes, the others inherit', () => {
    expect(resolveVector(entry, 'prod')).toEqual({
      ...envScopedEntry.vector,
      reversibility: 'irreversible',
      visibility: 'public',
    });
  });

  test('an env without override, no env, or no overrides at all : the base vector', () => {
    expect(resolveVector(entry, 'staging')).toBe(entry.vector);
    expect(resolveVector(entry, null)).toBe(entry.vector);
    expect(resolveVector(entry, undefined)).toBe(entry.vector);
    expect(resolveVector(entry, '')).toBe(entry.vector);
    expect(resolveVector({ vector: envScopedEntry.vector }, 'prod')).toBe(envScopedEntry.vector);
  });

  test('the base vector is not mutated', () => {
    const before = { ...entry.vector };
    resolveVector(entry, 'prod');
    expect(entry.vector).toEqual(before);
  });
});
