import { describe, expect, test } from 'vitest';

import type { RiskCatalog } from '@vaubaan/shared';

import type { ProviderPlugin } from '../../src/plugin.ts';
import { policyFromMacroActions } from '../../src/testing/index.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const perMinute = (max: number) => ({ max, window_seconds: 60 });

describe('policyFromMacroActions', () => {
  test('a mild macro-action at Prudent runs freely at its base budget', () => {
    expect(policyFromMacroActions(acmePlugin, { read: 'prudent' })).toEqual([
      { risk_id: 'acme.read-things', quota: 500, rate_limit: perMinute(60), gate: 'auto' },
    ]);
  });

  test('an env-scoped risk gets one line per environment given, its vector resolved there', () => {
    // `acme.thing-write` is mild on staging and costly on prod (vector_overrides).
    expect(
      policyFromMacroActions(acmePlugin, { write: 'prudent' }, { envs: ['staging', 'prod'] }),
    ).toEqual([
      { risk_id: 'acme[staging].thing-write', quota: 50, rate_limit: perMinute(10), gate: 'auto' },
      { risk_id: 'acme[prod].thing-write', quota: 50, rate_limit: perMinute(10), gate: 'approval' },
    ]);
  });

  test('no environment, or one the risk is not acceptable in, yields no env-scoped line', () => {
    expect(policyFromMacroActions(acmePlugin, { write: 'autonome' })).toEqual([]);
    expect(policyFromMacroActions(acmePlugin, { write: 'autonome' }, { envs: ['dev'] })).toEqual(
      [],
    );
  });

  test('the cran multiplies the budget and lifts the gate, catalog order kept', () => {
    expect(
      policyFromMacroActions(
        acmePlugin,
        { write: 'autonome', read: 'confiant' },
        { envs: ['prod'] },
      ),
    ).toEqual([
      { risk_id: 'acme.read-things', quota: 1500, rate_limit: perMinute(180), gate: 'auto' },
      { risk_id: 'acme[prod].thing-write', quota: 500, rate_limit: perMinute(100), gate: 'auto' },
    ]);
  });

  test('"Anything else" holds the fallback at the default base budget', () => {
    expect(policyFromMacroActions(acmePlugin, { 'anything-else': 'confiant' })).toEqual([
      {
        risk_id: 'acme.uncategorized-write',
        quota: 150,
        rate_limit: perMinute(30),
        gate: 'approval',
      },
    ]);
  });

  test('a macro-action the catalog does not declare is refused', () => {
    expect(() => policyFromMacroActions(acmePlugin, { admin: 'prudent' })).toThrow(
      /'admin' is not a macro-action of the 'acme' catalog/,
    );
  });

  test('a write-token handout asks first at every cran ; a read-only one follows its palier', () => {
    const [tool] = acmePlugin.tools;
    const handing = (
      readOnlyRiskIds?: string[],
    ): Pick<ProviderPlugin, 'catalog' | 'tokenHandouts'> => ({
      catalog: acmePlugin.catalog,
      tokenHandouts: [{ tool: tool!.name, riskIds: ['acme.read-things'], readOnlyRiskIds }],
    });
    expect(policyFromMacroActions(handing(), { read: 'autonome' })[0]!.gate).toBe('approval');
    expect(
      policyFromMacroActions(handing(['acme.read-things']), { read: 'autonome' })[0]!.gate,
    ).toBe('auto');
  });

  test('the catalog rate ceiling caps the rate ; a deprecated entry is left out', () => {
    const [read, ...rest] = acmePlugin.catalog.risks;
    const catalog: RiskCatalog = {
      ...acmePlugin.catalog,
      risks: [{ ...read!, infra_limits: { calls_per_minute_max: 20 } }, ...rest],
      macro_actions: [
        {
          id: 'read',
          label: 'Read',
          description: 'Read things.',
          entries: [
            { risk_id: 'acme.read-things', quota: 500, rate_limit: perMinute(60) },
            { risk_id: 'acme.legacy-export', quota: 5, rate_limit: perMinute(5) },
          ],
        },
      ],
    };
    expect(policyFromMacroActions({ catalog }, { read: 'autonome' })).toEqual([
      { risk_id: 'acme.read-things', quota: 5000, rate_limit: perMinute(20), gate: 'auto' },
    ]);
  });
});
