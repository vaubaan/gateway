import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  CatalogError,
  loadCatalogFile,
  parseCatalogYaml,
  validateCatalog,
} from '../../src/catalog-loader.ts';

const FIXTURE = new URL('../fixtures/acme/risk-catalog.yaml', import.meta.url);
const fixtureText = readFileSync(fileURLToPath(FIXTURE), 'utf8');

/** Minimal valid document, mutated by the error tests. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'acme',
    risks: [
      risk('acme.read-things', 'acme.space[**].thing[**].R'),
      {
        ...risk('acme.thing-write', 'acme.space[**].thing[**].W'),
        acceptable_in_envs: ['staging', 'prod'],
      },
      risk('acme.uncategorized-write', 'acme.**.W'),
    ],
    presets: [
      {
        id: 'reader',
        label: 'Reader',
        description: 'Reads.',
        entries: [
          {
            risk_id: 'acme.read-things',
            quota: 100,
            rate_limit: { max: 10, window_seconds: 60 },
            gate: 'auto',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function risk(id: string, matches: string): Record<string, unknown> {
  return {
    id,
    label: id,
    reason: 'because',
    matches,
    vector: {
      reversibility: 'reversible',
      blast: 'single',
      data: 'data',
      cost: 'free',
      visibility: 'internal',
      persistence: 'stateless',
    },
  };
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof CatalogError) return [...e.issues];
    throw e;
  }
  throw new Error('expected a CatalogError');
}

describe('loadCatalogFile — fixture', () => {
  const loaded = loadCatalogFile(FIXTURE);

  test('parses provider, version and the date scalar', () => {
    expect(loaded.catalog.provider).toBe('acme');
    expect(loaded.catalog.catalog_version).toBe(3);
    expect(loaded.catalog.catalog_date).toBe('2026-10-13');
  });

  test('keeps every risk and indexes every pattern', () => {
    expect(loaded.catalog.risks.map((r) => r.id)).toEqual([
      'acme.read-things',
      'acme.thing-write',
      'acme.legacy-export',
      'acme.uncategorized-write',
    ]);
    expect(loaded.indexed.entries).toHaveLength(4);
    expect(loaded.indexed.entries[0]!.patterns).toHaveLength(1);
  });

  test('carries optional fields through', () => {
    const write = loaded.catalog.risks[1]!;
    expect(write.acceptable_in_envs).toEqual(['staging', 'prod']);
    expect(write.vector_overrides).toEqual({
      prod: { reversibility: 'costly', visibility: 'public' },
    });
    expect(write.caps).toEqual({ items_per_call_max: 50 });
    expect(loaded.catalog.risks[2]!.deprecated).toBe(true);
  });

  test('loads the presets with default gate auto', () => {
    expect(loaded.catalog.presets.map((p) => p.id)).toEqual(['reader', 'developer']);
    const dev = loaded.catalog.presets[1]!;
    expect(dev.entries[0]).toEqual({
      risk_id: 'acme.read-things',
      quota: 2000,
      rate_limit: { max: 120, window_seconds: 60 },
      gate: 'auto',
    });
    expect(dev.entries[2]!.gate).toBe('approval');
  });

  test('parseCatalogYaml gives the same result from text', () => {
    expect(parseCatalogYaml(fixtureText, { source: 'fixture' }).catalog).toEqual(loaded.catalog);
  });
});

describe('validateCatalog — errors are collected and path-qualified', () => {
  test('duplicate ids', () => {
    const d = doc();
    (d.risks as unknown[]).push(risk('acme.read-things', 'acme.space[**].R'));
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(
      /Duplicate risk id 'acme.read-things'/,
    );
  });

  test('malformed id', () => {
    const d = doc({
      risks: [risk('Acme.Read', 'acme.space[**].R'), risk('acme.uncategorized-write', 'acme.**.W')],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^risks\[0\]\.id 'Acme.Read' does not match/)]),
    );
  });

  test('id of another provider', () => {
    const d = doc({
      risks: [
        risk('other.read', 'acme.space[**].R'),
        risk('acme.uncategorized-write', 'acme.**.W'),
      ],
    });
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(
      /risks\[0\]\.id 'other.read' belongs to provider 'other'/,
    );
  });

  test('malformed slice pattern', () => {
    const d = doc({
      risks: [risk('acme.read', 'acme.space[[.R'), risk('acme.uncategorized-write', 'acme.**.W')],
    });
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(
      /Invalid 'matches' pattern in risk 'acme.read'/,
    );
  });

  test('missing fallback is an error, unless disabled', () => {
    const d = doc({ risks: [risk('acme.read-things', 'acme.space[**].R')] });
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(/missing fallback risk/);
    expect(() => validateCatalog(d, { requireFallback: false })).not.toThrow();
  });

  test('zero presets is an error, unless disabled', () => {
    const d = doc({ presets: [] });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      expect.stringMatching(/at least one preset/),
    ]);
    expect(() => validateCatalog(d, { requirePresets: false })).not.toThrow();
    const noKey = doc();
    delete noKey.presets;
    expect(issuesOf(() => validateCatalog(noKey))).toEqual([
      expect.stringMatching(/at least one preset/),
    ]);
  });

  test('preset entry referencing a foreign or unknown risk', () => {
    const d = doc();
    (d.presets as Array<{ entries: unknown[] }>)[0]!.entries.push(
      {
        risk_id: 'github.read-code',
        quota: 1,
        rate_limit: { max: 1, window_seconds: 1 },
        gate: 'auto',
      },
      { risk_id: 'acme.nope', quota: 1, rate_limit: { max: 1, window_seconds: 1 }, gate: 'auto' },
    );
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /presets\[0\]\.entries\[1\]\.risk_id 'github.read-code' belongs to provider 'github'/,
        ),
        expect.stringMatching(
          /presets\[0\]\.entries\[2\]\.risk_id 'acme.nope' is not a risk of the 'acme' catalog/,
        ),
      ]),
    );
  });

  test('env-qualified preset entries must target an env-scoped risk and an allowed env', () => {
    const d = doc();
    (d.presets as Array<{ entries: unknown[] }>)[0]!.entries.push(
      {
        risk_id: 'acme[prod].read-things',
        quota: 1,
        rate_limit: { max: 1, window_seconds: 1 },
        gate: 'auto',
      },
      {
        risk_id: 'acme[dev].thing-write',
        quota: 1,
        rate_limit: { max: 1, window_seconds: 1 },
        gate: 'auto',
      },
      {
        risk_id: 'acme[staging].thing-write',
        quota: 1,
        rate_limit: { max: 1, window_seconds: 1 },
        gate: 'approval',
      },
    );
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toMatch(
      /'acme\[prod\].read-things' qualifies an env on a risk that is not env-scoped/,
    );
    expect(issues.join('\n')).toMatch(
      /'acme\[dev\].thing-write' uses env 'dev' outside acceptable_in_envs \[staging, prod\]/,
    );
  });

  test('wildcard or sentinel in a preset entry', () => {
    const d = doc();
    (d.presets as Array<{ entries: unknown[] }>)[0]!.entries.push(
      { risk_id: 'acme.*', quota: 1, rate_limit: { max: 1, window_seconds: 1 } },
      { risk_id: 'all', quota: 1, rate_limit: { max: 1, window_seconds: 1 } },
    );
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues.filter((m) => /not an explicit RiskId/.test(m))).toHaveLength(2);
  });

  test('budget must be explicit positive integers, gate from the closed set', () => {
    const d = doc({
      presets: [
        {
          id: 'bad',
          label: 'Bad',
          description: 'x',
          entries: [
            {
              risk_id: 'acme.read-things',
              quota: 0,
              rate_limit: { max: 1.5, window_seconds: 'x' },
              gate: 'maybe',
            },
          ],
        },
      ],
    });
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/presets\[0\]\.entries\[0\]\.quota: expected a positive integer/),
        expect.stringMatching(/rate_limit\.max: expected a positive integer/),
        expect.stringMatching(/rate_limit\.window_seconds: expected a positive integer/),
        expect.stringMatching(/gate: expected one of auto \| approval/),
      ]),
    );
  });

  test('deprecated risks may not appear in a preset', () => {
    const d = doc();
    (d.risks as unknown[]).push({ ...risk('acme.old', 'acme.space[**].old.R'), deprecated: true });
    (d.presets as Array<{ entries: unknown[] }>)[0]!.entries.push({
      risk_id: 'acme.old',
      quota: 1,
      rate_limit: { max: 1, window_seconds: 1 },
    });
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(/'acme.old' is deprecated/);
  });

  test('unknown keys, bad vector values and bad env labels are reported at their path', () => {
    const d = doc();
    (d.risks as Record<string, unknown>[])[0]!.colour = 'red';
    ((d.risks as Record<string, unknown>[])[0]!.vector as Record<string, unknown>).blast = 'planet';
    (d.risks as Record<string, unknown>[])[1]!.acceptable_in_envs = ['Prod'];
    d.extra = 1;
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues).toEqual(
      expect.arrayContaining([
        'extra: unknown key',
        'risks[0].colour: unknown key',
        'risks[0].vector.blast: expected one of single | env | account | bulk',
        'risks[1].acceptable_in_envs[0]: invalid env label',
      ]),
    );
  });

  test('provider slug and top-level shape', () => {
    expect(issuesOf(() => validateCatalog('nope'))).toEqual([
      expect.stringMatching(/expected a mapping/),
    ]);
    expect(issuesOf(() => validateCatalog(doc({ provider: 'Acme_Co' }))).join('\n')).toMatch(
      /provider: expected a lowercase slug/,
    );
    expect(issuesOf(() => validateCatalog(doc({ risks: [] }))).join('\n')).toMatch(
      /risks: expected a non-empty list/,
    );
  });

  test('YAML syntax errors surface as a CatalogError naming the source', () => {
    const err = (() => {
      try {
        parseCatalogYaml('provider: [unclosed', { source: 'broken.yaml' });
      } catch (e) {
        return e as CatalogError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(CatalogError);
    expect(err!.source).toBe('broken.yaml');
    expect(err!.issues[0]).toMatch(/^YAML syntax:/);
  });
});
