import { describe, expect, test } from 'vitest';
import type { RiskCatalog, RiskEntry, RiskPolicyOverride } from '@vaubaan/shared';

import { indexCatalog } from '../../src/risk-evaluator.ts';
import {
  checkAcceptableInEnv,
  prepareCatalog,
  requiresAdminToOverrideDenyAllow,
  resolveEffectiveGate,
  resolveEffectiveGates,
  RISK_ID_REGEX,
  seedDefaultGate,
} from '../../src/risk-policy.ts';

const catalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-rows',
      label: 'Read rows',
      reason: 'OK',
      matches: 'supabase.project[**].schema[**].table[**].row[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
      default_gate: 'allow',
    },
    {
      id: 'supabase[staging].bulk-row-write',
      label: 'Bulk staging',
      reason: 'No rollback.',
      matches: 'supabase.project[**].schema[**].table[**].row[*].W',
      vector: {
        reversibility: 'irreversible',
        blast: 'bulk',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'confirm',
      acceptable_in_envs: ['staging', 'preview'],
    },
    {
      id: 'supabase.policy-write',
      label: 'RLS write',
      reason: 'Posture.',
      matches: 'supabase.project[**].policy[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'team',
        persistence: 'posture',
      },
      default_gate: 'deny',
    },
    {
      id: 'supabase.uncategorized-write',
      label: 'Fallback',
      reason: 'Catch.',
      matches: 'supabase.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'confirm',
    },
  ],
};

const idx = indexCatalog(catalog);

const ov = (
  partial: Pick<RiskPolicyOverride, 'risk_id' | 'env_scope' | 'gate'>,
): RiskPolicyOverride => ({
  id: 'o-1',
  project_id: 'p1',
  created_at: 'now',
  ...partial,
});

describe('resolveEffectiveGate', () => {
  test('catalog default when no override', () => {
    const d = resolveEffectiveGate('supabase.read-rows', 'staging', idx, []);
    expect(d.gate).toBe('allow');
    expect(d.origin).toBe('catalog-default');
  });

  test('env-scoped override wins over global override', () => {
    const overrides = [
      ov({ risk_id: 'supabase.read-rows', env_scope: null, gate: 'confirm' }),
      ov({ risk_id: 'supabase.read-rows', env_scope: 'prod', gate: 'deny' }),
    ];
    expect(resolveEffectiveGate('supabase.read-rows', 'prod', idx, overrides).gate).toBe('deny');
    expect(resolveEffectiveGate('supabase.read-rows', 'staging', idx, overrides).gate).toBe(
      'confirm',
    );
  });

  test('unknown risk id falls back to deny', () => {
    const d = resolveEffectiveGate('supabase.no-such', 'prod', idx, []);
    expect(d.gate).toBe('deny');
    expect(d.entry).toBeUndefined();
  });

  test('account-scope env=null', () => {
    expect(resolveEffectiveGate('supabase.policy-write', null, idx, []).gate).toBe('deny');
  });
});

describe('resolveEffectiveGates', () => {
  test('batch', () => {
    const out = resolveEffectiveGates(
      ['supabase.read-rows', 'supabase.policy-write'],
      'staging',
      idx,
      [],
    );
    expect(out.map((d) => d.gate)).toEqual(['allow', 'deny']);
  });
});

describe('checkAcceptableInEnv', () => {
  const bulkEntry = catalog.risks[1]!;

  test('OK on allowed env', () => {
    expect(checkAcceptableInEnv(bulkEntry, 'staging')).toBeNull();
    expect(checkAcceptableInEnv(bulkEntry, 'preview')).toBeNull();
  });

  test('refuses on prod', () => {
    expect(checkAcceptableInEnv(bulkEntry, 'prod')).toContain("not acceptable in env 'prod'");
  });

  test('refuses on account-scope when restricted', () => {
    expect(checkAcceptableInEnv(bulkEntry, null)).toContain('account-scope');
  });

  test('no restriction → OK', () => {
    const free = catalog.risks[0]!;
    expect(checkAcceptableInEnv(free, 'prod')).toBeNull();
  });
});

describe('requiresAdminToOverrideDenyAllow', () => {
  test('posture entries → admin only', () => {
    const policy = catalog.risks[2]!;
    expect(requiresAdminToOverrideDenyAllow(policy)).toBe(true);
  });

  test('secret W → admin only', () => {
    const secretWrite: RiskEntry = {
      ...catalog.risks[0]!,
      id: 'vercel[prod].env-var-write',
      matches: 'vercel.env-var[*].W',
      vector: { ...catalog.risks[0]!.vector, data: 'secret', persistence: 'session' },
      default_gate: 'deny',
    };
    expect(requiresAdminToOverrideDenyAllow(secretWrite)).toBe(true);
  });

  test('plain reversible W → no admin needed', () => {
    const easy: RiskEntry = {
      ...catalog.risks[0]!,
      matches: 'supabase.**.W',
      vector: { ...catalog.risks[0]!.vector, data: 'data', persistence: 'session' },
      default_gate: 'confirm',
    };
    expect(requiresAdminToOverrideDenyAllow(easy)).toBe(false);
  });
});

describe('seedDefaultGate', () => {
  test('posture → deny', () => {
    expect(
      seedDefaultGate({
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      }),
    ).toBe('deny');
  });

  test('secret W → deny', () => {
    expect(
      seedDefaultGate(
        {
          reversibility: 'reversible',
          blast: 'single',
          data: 'secret',
          cost: 'free',
          visibility: 'internal',
          persistence: 'session',
        },
        'W',
      ),
    ).toBe('deny');
  });

  test('irreversible → confirm', () => {
    expect(
      seedDefaultGate({
        reversibility: 'irreversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      }),
    ).toBe('confirm');
  });

  test('bulk → confirm', () => {
    expect(
      seedDefaultGate({
        reversibility: 'reversible',
        blast: 'bulk',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      }),
    ).toBe('confirm');
  });

  test('benign → allow', () => {
    expect(
      seedDefaultGate({
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      }),
    ).toBe('allow');
  });
});

describe('prepareCatalog', () => {
  test('OK with valid catalog', () => {
    expect(() => prepareCatalog(catalog)).not.toThrow();
  });

  test('rejects duplicate ids', () => {
    const dup = {
      ...catalog,
      risks: [...catalog.risks, catalog.risks[0]!],
    };
    expect(() => prepareCatalog(dup)).toThrow(/Duplicate/);
  });

  test('rejects bad RiskId format', () => {
    const bad: RiskCatalog = {
      ...catalog,
      risks: [...catalog.risks, { ...catalog.risks[0]!, id: 'NOT_KEBAB.WTF' }],
    };
    expect(() => prepareCatalog(bad)).toThrow(/format/);
  });
});

describe('RISK_ID_REGEX', () => {
  test('accepts simple', () => {
    expect(RISK_ID_REGEX.test('github.read-code')).toBe(true);
  });

  test('accepts env-scoped', () => {
    expect(RISK_ID_REGEX.test('supabase[staging].bulk-row-write')).toBe(true);
    expect(RISK_ID_REGEX.test('vercel[prod].env-var-write')).toBe(true);
  });

  test('rejects uppercase', () => {
    expect(RISK_ID_REGEX.test('GitHub.write')).toBe(false);
  });

  test('rejects nested dots in env', () => {
    expect(RISK_ID_REGEX.test('github[a.b].thing')).toBe(false);
  });

  test('rejects empty name', () => {
    expect(RISK_ID_REGEX.test('github.')).toBe(false);
  });
});
