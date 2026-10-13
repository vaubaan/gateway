import { describe, expect, test } from 'vitest';
import type { Resource, RiskCatalog } from '@vaubaan/shared';

import { indexCatalog } from '../../src/risk-evaluator.ts';
import { evaluateCall, evaluateCallSimple } from '../../src/risk-runtime.ts';
import { resourceEnvResolver } from '../../src/qualify.ts';
import { parseSlice } from '../../src/slice-dsl.ts';

const catalog: RiskCatalog = {
  provider: 'github',
  risks: [
    {
      id: 'github.read-code',
      label: 'read',
      reason: 'r',
      matches: 'github.repo[**].file[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'github.feature-branch-write',
      label: 'feat',
      reason: 'r',
      matches: 'github.repo[**].branch[feature/*,fix/*].file[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'github.merge-protected',
      label: 'merge',
      reason: 'r',
      matches: 'github.repo[**].branch[main,master,prod].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'github.uncategorized-write',
      label: 'fallback',
      reason: 'r',
      matches: 'github.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};

const idx = indexCatalog(catalog);

describe('evaluateCall — allow path', () => {
  test('feature branch write allowed with feature-branch-write alone (fallback not co-touched)', () => {
    // Inverted on purpose (ADR fallback-risk-only-when-uncategorized) : a mission built from a
    // preset without the fallback can still write on feature branches.
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[feature/x].file[a.ts].W')],
      token_accepted_risks: new Set(['github.feature-branch-write']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toEqual(['github.feature-branch-write']);
    }
  });

  test('an uncategorized write needs the fallback, and only the fallback', () => {
    const slice = parseSlice('github.repo[foo].webhook[h1].W');
    const refused = evaluateCall({
      executed_slices: [slice],
      token_accepted_risks: new Set(['github.feature-branch-write', 'github.merge-protected']),
      catalog: idx,
    });
    expect(refused.outcome).toBe('denied');
    if (refused.outcome === 'denied')
      expect(refused.missing_risks).toEqual(['github.uncategorized-write']);
    const allowed = evaluateCall({
      executed_slices: [slice],
      token_accepted_risks: new Set(['github.uncategorized-write']),
      catalog: idx,
    });
    expect(allowed.outcome).toBe('allowed');
  });

  test('read code accepted', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });
});

describe('evaluateCall — denied paths', () => {
  test('missing risk → deny with missing_risks', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[main].W')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.code).toBe('risk-not-accepted');
      expect(d.missing_risks).toEqual(['github.merge-protected']);
      // The fallback is not co-touched by a categorized write (ADR fallback-risk-only-when-uncategorized).
      expect(d.missing_risks).not.toContain('github.uncategorized-write');
      expect(d.hint).toContain('does not accept');
    }
  });

  test('every denial carries the structured code `risk-not-accepted`', () => {
    const denials = [
      evaluateCall({ executed_slices: [], token_accepted_risks: new Set(), catalog: idx }),
      evaluateCall({
        executed_slices: [parseSlice('github.repo[foo].W')],
        token_accepted_risks: new Set(),
        catalog: indexCatalog({ provider: 'github', risks: [] }),
      }),
      evaluateCall({
        executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
        token_accepted_risks: new Set(['github.read-code']),
        token_denied_risks: new Set(['github.read-code']),
        catalog: idx,
      }),
      evaluateCall({
        executed_slices: [parseSlice('github.repo[foo].branch[main].W')],
        token_accepted_risks: new Set(),
        catalog: idx,
      }),
    ];
    for (const d of denials) {
      expect(d.outcome).toBe('denied');
      if (d.outcome === 'denied') expect(d.code).toBe('risk-not-accepted');
    }
  });

  test('explicit deny wins over acceptance', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      token_denied_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toEqual(['github.read-code']);
      expect(d.hint).toContain('explicitly denies');
    }
  });

  test('no slice → deny (classification gap)', () => {
    const d = evaluateCall({
      executed_slices: [],
      token_accepted_risks: new Set(),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no slice');
    }
  });

  test('no risk in catalog matches the slice → deny', () => {
    const otherCatalog: RiskCatalog = { provider: 'github', risks: [] };
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].W')],
      token_accepted_risks: new Set(),
      catalog: indexCatalog(otherCatalog),
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no risk');
      expect(d.hint).toContain('catalog matches');
    }
  });
});

describe('evaluateCall — multi-slice scenarios', () => {
  test('multi-slice : all risks must be covered', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set(['github.read-code', 'github.merge-protected']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });

  test('multi-slice : missing one fails the whole call', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set(['github.read-code']), // missing merge-protected
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
  });
});

describe('evaluateCallSimple — convenience wrapper', () => {
  test('end-to-end happy path', () => {
    const d = evaluateCallSimple(
      catalog,
      [parseSlice('github.repo[foo].file[a.ts].R')],
      ['github.read-code'],
    );
    expect(d.outcome).toBe('allowed');
  });
});

// ─── env-scoped subset check (spec §4.4) ─────────────────────────────────────

describe('evaluateCall — env-qualified subset check', () => {
  const supabaseCatalog: RiskCatalog = {
    provider: 'supabase',
    risks: [
      {
        id: 'supabase.bulk-row-write',
        label: 'bulk',
        reason: 'bulk row write',
        matches: 'supabase.project[**].schema[**].table[**].row[bulk].W',
        vector: {
          reversibility: 'costly',
          blast: 'bulk',
          data: 'data',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'session',
        },
        acceptable_in_envs: ['staging', 'prod'],
      },
    ],
  };
  const supabaseIdx = indexCatalog(supabaseCatalog);

  const stagingResource: Resource = {
    provider: 'supabase',
    ref: 'staging-ref',
    env: 'staging',
    displayName: 'staging-ref',
  };
  const prodResource: Resource = {
    provider: 'supabase',
    ref: 'prod-ref',
    env: 'prod',
    displayName: 'prod-ref',
  };

  const stagingBulkSlice = parseSlice(
    'supabase.project[staging-ref].schema[any].table[any].row[bulk].W',
  );
  const prodBulkSlice = parseSlice('supabase.project[prod-ref].schema[any].table[any].row[bulk].W');

  test('token accepted `supabase[staging].bulk-row-write` allows a call on the staging resource', () => {
    const d = evaluateCall({
      executed_slices: [stagingBulkSlice],
      token_accepted_risks: new Set(['supabase[staging].bulk-row-write']),
      catalog: supabaseIdx,
      envResolver: resourceEnvResolver([stagingResource, prodResource]),
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toEqual(['supabase[staging].bulk-row-write']);
    }
  });

  test('token accepted `supabase[staging].bulk-row-write` denies a call on the prod resource', () => {
    const d = evaluateCall({
      executed_slices: [prodBulkSlice],
      token_accepted_risks: new Set(['supabase[staging].bulk-row-write']),
      catalog: supabaseIdx,
      envResolver: resourceEnvResolver([stagingResource, prodResource]),
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      // The missing risk is the qualified one for the prod env.
      expect(d.missing_risks).toContain('supabase[prod].bulk-row-write');
    }
  });

  test('no resolver provided → risks_touched returned non-qualified (test mode)', () => {
    const d = evaluateCall({
      executed_slices: [stagingBulkSlice],
      // The mission would have to use the non-qualified id when no resolver
      // is given (this is the test entrypoint).
      token_accepted_risks: new Set(['supabase.bulk-row-write']),
      catalog: supabaseIdx,
    });
    expect(d.outcome).toBe('allowed');
  });
});

// ─── acceptable_in_envs runtime filter (Railway upsert-variable) ────────────

describe('evaluateCall — acceptable_in_envs runtime filter', () => {
  // Post-merge: single upsert-variable entry with vector_overrides for prod.
  const railwayCatalog: RiskCatalog = {
    provider: 'railway',
    risks: [
      {
        id: 'railway.upsert-variable',
        label: 'Modify an env var',
        reason: 'r',
        matches: 'railway.project[**].environment[**].service-var[**].W',
        acceptable_in_envs: ['staging', 'preview', 'dev', 'prod'],
        vector: {
          reversibility: 'reversible',
          blast: 'env',
          data: 'secret',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'posture',
        },
        vector_overrides: {
          prod: { reversibility: 'costly' },
        },
      },
      {
        id: 'railway.uncategorized-write',
        label: 'fallback',
        reason: 'r',
        matches: 'railway.**.W',
        vector: {
          reversibility: 'costly',
          blast: 'env',
          data: 'data',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'session',
        },
      },
    ],
  };
  const railwayIdx = indexCatalog(railwayCatalog);

  const prodResource: Resource = {
    provider: 'railway',
    ref: 'pid-123',
    env: 'prod',
    displayName: 'pid-123',
  };

  const stagingResource: Resource = {
    provider: 'railway',
    ref: 'pid-456',
    env: 'staging',
    displayName: 'pid-456',
  };

  const prodSlice = parseSlice('railway.project[pid-123].environment[prod].service-var[MY_VAR].W');
  const stagingSlice = parseSlice(
    'railway.project[pid-456].environment[staging].service-var[MY_VAR].W',
  );

  // The fallback no longer co-fires with `upsert-variable` (ADR fallback-risk-only-when-uncategorized) :
  // the env-qualified entry alone is touched and accepted.
  test('prod resource: upsert-variable fires with env-qualified id', () => {
    const d = evaluateCall({
      executed_slices: [prodSlice],
      token_accepted_risks: new Set(['railway[prod].upsert-variable']),
      catalog: railwayIdx,
      envResolver: resourceEnvResolver([prodResource]),
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toEqual(['railway[prod].upsert-variable']);
    }
  });

  test('staging resource: upsert-variable fires with staging-qualified id', () => {
    const d = evaluateCall({
      executed_slices: [stagingSlice],
      token_accepted_risks: new Set(['railway[staging].upsert-variable']),
      catalog: railwayIdx,
      envResolver: resourceEnvResolver([stagingResource]),
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toEqual(['railway[staging].upsert-variable']);
    }
  });

  test('prod resource without upsert-variable accepted → deny', () => {
    const d = evaluateCall({
      executed_slices: [prodSlice],
      token_accepted_risks: new Set(['railway.uncategorized-write']),
      catalog: railwayIdx,
      envResolver: resourceEnvResolver([prodResource]),
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toContain('railway[prod].upsert-variable');
    }
  });
});

// ─── An env-scoped risk touched outside its envs refuses, never vanishes ────

describe('evaluateCall — env-scoped risk outside its acceptable envs', () => {
  const vector = {
    reversibility: 'reversible',
    blast: 'single',
    data: 'data',
    cost: 'free',
    visibility: 'internal',
    persistence: 'stateless',
  } as const;
  const acme: RiskCatalog = {
    provider: 'acme',
    risks: [
      // Broad, account-scoped read that co-fires with the specific one below.
      {
        id: 'acme.read-runtime',
        label: 'read runtime',
        reason: 'r',
        matches: 'acme.project[**].**.R',
        vector,
      },
      {
        id: 'acme.read-variables',
        label: 'read variable values',
        reason: 'r',
        matches: 'acme.project[**].variable[**].R',
        vector,
        acceptable_in_envs: ['staging', 'prod'],
      },
      {
        id: 'acme.schema-write',
        label: 'schema write',
        reason: 'r',
        matches: 'acme.project[**].table[*].W',
        vector,
        acceptable_in_envs: ['staging', 'prod'],
      },
      {
        id: 'acme.bulk-row-write',
        label: 'bulk row write',
        reason: 'r',
        matches: 'acme.project[**].table[**].row[bulk].W',
        vector,
        acceptable_in_envs: ['staging'],
      },
    ],
  };
  const acmeIdx = indexCatalog(acme);
  const resource = (ref: string, env: string | null): Resource => ({
    provider: 'acme',
    ref,
    env,
    displayName: ref,
  });
  const readVariables = (ref: string) => parseSlice(`acme.project[${ref}].variable[DB_URL].R`);

  test('labelled resource: the specific risk is required on top of the broad one', () => {
    const d = evaluateCall({
      executed_slices: [readVariables('p1')],
      token_accepted_risks: new Set(['acme.read-runtime']),
      catalog: acmeIdx,
      envResolver: resourceEnvResolver([resource('p1', 'prod')]),
    });
    expect(d).toMatchObject({ outcome: 'denied', missing_risks: ['acme[prod].read-variables'] });
  });

  test.each([
    ['no environment label', null, 'acme.read-variables'],
    ['a label outside the list', 'production', 'acme[production].read-variables'],
  ])(
    'resource with %s: the broad co-touched risk does not carry the call alone',
    (_title, env, missing) => {
      const d = evaluateCall({
        executed_slices: [readVariables('p1')],
        token_accepted_risks: new Set(['acme.read-runtime']),
        catalog: acmeIdx,
        envResolver: resourceEnvResolver([resource('p1', env)]),
      });
      expect(d.outcome).toBe('denied');
      if (d.outcome !== 'denied') return;
      expect(d.code).toBe('risk-not-accepted');
      expect(d.missing_risks).toEqual([missing]);
      expect(d.covered_risks).toEqual(['acme.read-runtime']);
      expect(d.hint).toContain('acceptable only in [staging, prod]');
    },
  );

  test('multi-slice call: a risk not acceptable in this env refuses the whole call', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('acme.project[p1].table[users].W'),
        parseSlice('acme.project[p1].table[users].row[bulk].W'),
      ],
      token_accepted_risks: new Set(['acme[prod].schema-write']),
      catalog: acmeIdx,
      envResolver: resourceEnvResolver([resource('p1', 'prod')]),
    });
    expect(d).toMatchObject({
      outcome: 'denied',
      missing_risks: ['acme[prod].bulk-row-write'],
      covered_risks: ['acme[prod].schema-write'],
    });
  });

  test('holding the unqualified id does not open an unlabelled resource', () => {
    const d = evaluateCall({
      executed_slices: [readVariables('p1')],
      token_accepted_risks: new Set(['acme.read-runtime', 'acme.read-variables']),
      catalog: acmeIdx,
      envResolver: resourceEnvResolver([resource('p1', null)]),
    });
    expect(d).toMatchObject({ outcome: 'denied', missing_risks: ['acme.read-variables'] });
  });

  test('the same slices are allowed where every touched risk is acceptable and accepted', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('acme.project[p1].table[users].W'),
        parseSlice('acme.project[p1].table[users].row[bulk].W'),
      ],
      token_accepted_risks: new Set(['acme[staging].schema-write', 'acme[staging].bulk-row-write']),
      catalog: acmeIdx,
      envResolver: resourceEnvResolver([resource('p1', 'staging')]),
    });
    expect(d.outcome).toBe('allowed');
  });
});
