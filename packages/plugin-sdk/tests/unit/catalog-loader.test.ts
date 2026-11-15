import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { RiskCatalog } from '@vaubaan/shared';

import {
  CatalogError,
  loadCatalogFile,
  parseCatalogYaml,
  validateCatalog,
} from '../../src/catalog-loader.ts';
import { NARRATIVE_MAX_LENGTH } from '../../src/catalog-document.ts';
import { isCompleteVector } from '../../src/catalog-risk-entry.ts';
import {
  catalogWarnings,
  RETIRED_PRESETS_ISSUE,
  riskIdWildcardIssues,
  semanticIssues,
  wildcardIssues,
} from '../../src/catalog-rules.ts';

const FIXTURE = new URL('../fixtures/acme/risk-catalog.yaml', import.meta.url);
const fixtureText = readFileSync(fileURLToPath(FIXTURE), 'utf8');

/**
 * Minimal valid document, mutated by the error tests. Unless a test gives its
 * own, the macro-actions keep only the entries whose risk is still declared.
 */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = baseDoc(overrides);
  if ('macro_actions' in overrides || !Array.isArray(base.risks)) return base;
  const ids = new Set((base.risks as { id?: unknown }[]).map((r) => r.id));
  const actions = (base.macro_actions as { entries: { risk_id: string }[] }[])
    .map((a) => ({ ...a, entries: a.entries.filter((e) => ids.has(e.risk_id)) }))
    .filter((a) => a.entries.length > 0);
  return { ...base, macro_actions: actions };
}

function baseDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    service: 'acme',
    risks: [
      risk('acme.read-things', 'acme.space[**].thing[**].R'),
      {
        ...risk('acme.thing-write', 'acme.space[**].thing[**].W'),
        acceptable_in_envs: ['staging', 'prod'],
      },
      { ...risk('acme.uncategorized-write', 'acme.**.W'), fallback: true },
    ],
    macro_actions: [
      {
        id: 'read',
        label: 'Read',
        description: 'Reads.',
        entries: [
          { risk_id: 'acme.read-things', quota: 100, rate_limit: { max: 10, window_seconds: 60 } },
        ],
      },
      {
        id: 'write',
        label: 'Write',
        description: 'Writes.',
        entries: [
          { risk_id: 'acme.thing-write', quota: 10, rate_limit: { max: 5, window_seconds: 60 } },
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

  test('parses service, version and the date scalar', () => {
    expect(loaded.catalog.service).toBe('acme');
    expect(loaded.catalog.catalog_version).toBe(4);
    expect(loaded.catalog.catalog_date).toBe('2026-10-31');
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
    expect(loaded.catalog.risks[3]!.fallback).toBe(true);
    expect(loaded.indexed.entries.map((e) => e.fallback)).toEqual([false, false, false, true]);
    expect(write.acceptable_in_envs).toEqual(['staging', 'prod']);
    expect(write.vector_overrides).toEqual({
      prod: { reversibility: 'costly', visibility: 'public' },
    });
    expect(write.caps).toEqual({ items_per_call_max: 50 });
    expect(loaded.catalog.risks[2]!.deprecated).toBe(true);
  });

  test('loads the macro-action entries with their base budgets and no gate', () => {
    expect(loaded.catalog.macro_actions[0]!.entries[0]).toEqual({
      risk_id: 'acme.read-things',
      quota: 500,
      rate_limit: { max: 60, window_seconds: 60 },
    });
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

  test('id of another service', () => {
    const d = doc({
      risks: [
        risk('other.read', 'acme.space[**].R'),
        risk('acme.uncategorized-write', 'acme.**.W'),
      ],
    });
    expect(issuesOf(() => validateCatalog(d)).join('\n')).toMatch(
      /risks\[0\]\.id 'other.read' belongs to service 'other'/,
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

  test('exactly one fallback : flag, catch-all pattern or uncategorized- id all count', () => {
    // Two detected fallbacks (one by its uncategorized- id, one by flag).
    const two = doc();
    (two.risks as unknown[]).push({ ...risk('acme.everything', 'acme.[**].W'), fallback: true });
    expect(issuesOf(() => validateCatalog(two)).join('\n')).toMatch(
      /exactly one fallback entry per catalog, found 2 \('acme.uncategorized-write', 'acme.everything'\)/,
    );
    // The flag alone makes an entry the fallback — and it must be named uncategorized-*.
    const misnamed = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        { ...risk('acme.catch-all', 'acme.**.W'), fallback: true },
      ],
    });
    expect(issuesOf(() => validateCatalog(misnamed))).toEqual([
      "risks[1].id 'acme.catch-all' is the fallback and must be named 'acme.uncategorized-*'",
    ]);
    // `fallback: false` on the catch-all entry opts it out → no fallback left.
    const optedOut = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        { ...risk('acme.uncategorized-write', 'acme.**.W'), fallback: false },
      ],
    });
    expect(issuesOf(() => validateCatalog(optedOut)).join('\n')).toMatch(/missing fallback risk/);
    // Not a boolean.
    const bad = doc();
    (bad.risks as Record<string, unknown>[])[2]!.fallback = 'yes';
    expect(issuesOf(() => validateCatalog(bad))).toEqual(['risks[2].fallback: expected a boolean']);
  });

  test('the fallback must match the catch-all write, whatever made it the fallback', () => {
    // Flagged on a narrow pattern : that risk would be left out of the
    // touched risks as soon as another entry matched the same slice.
    const flagged = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        { ...risk('acme.uncategorized-write', 'acme.space[**].thing[**].W'), fallback: true },
      ],
    });
    expect(issuesOf(() => validateCatalog(flagged))).toEqual([
      "risks[1].matches: the fallback 'acme.uncategorized-write' must match the catch-all write 'acme.**.W'",
    ]);
    // Recognised by its id alone : same rule.
    const byId = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        risk('acme.uncategorized-write', 'acme.space[**].W'),
      ],
    });
    expect(issuesOf(() => validateCatalog(byId))).toEqual([
      "risks[1].matches: the fallback 'acme.uncategorized-write' must match the catch-all write 'acme.**.W'",
    ]);
    // One catch-all among several patterns is enough ; the bracketed spelling counts.
    const listed = doc();
    (listed.risks as Record<string, unknown>[])[2]!.matches = ['acme.space[**].W', 'acme.[**].W'];
    expect(() => validateCatalog(listed)).not.toThrow();
    // A read catch-all is not the catch-all write.
    const read = doc();
    (read.risks as Record<string, unknown>[])[2]!.matches = 'acme.**.R';
    expect(issuesOf(() => validateCatalog(read)).join('\n')).toMatch(
      /risks\[2\]\.matches: the fallback .* must match the catch-all write/,
    );
  });

  test('the uncategorized- id convention needs its dash', () => {
    // `acme.uncategorizedfoo` is an ordinary risk : without a flag and
    // without the catch-all pattern, the catalog has no fallback, and the
    // risk then needs a macro-action like any other.
    const d = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        risk('acme.uncategorizedfoo', 'acme.space[**].W'),
      ],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      "missing fallback risk: declare a 'acme.uncategorized-*' entry matching 'acme.**.W' with fallback: true (risk-model spec §4.3)",
      "risks: 'acme.uncategorizedfoo' belongs to no macro-action",
    ]);
    // Flagged, it is the fallback — and then it is misnamed.
    const flagged = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        { ...risk('acme.uncategorizedfoo', 'acme.**.W'), fallback: true },
      ],
    });
    expect(issuesOf(() => validateCatalog(flagged))).toEqual([
      "risks[1].id 'acme.uncategorizedfoo' is the fallback and must be named 'acme.uncategorized-*'",
    ]);
  });

  test('a fallback recognised by convention alone loads with a warning asking for the flag', () => {
    // Third-party catalog written before the flag : pattern and id convention.
    const legacy = doc({
      risks: [
        risk('acme.read-things', 'acme.space[**].R'),
        risk('acme.uncategorized-write', 'acme.**.W'),
      ],
    });
    const warnings: string[] = [];
    const loaded = validateCatalog(legacy, { source: 'acme.yaml', warn: (m) => warnings.push(m) });
    expect(loaded.indexed.entries.map((e) => e.fallback)).toEqual([false, true]);
    expect(warnings).toEqual([
      "[plugin-sdk] catalog 'acme.yaml': risks[1].id 'acme.uncategorized-write' is the fallback by convention only — set fallback: true on it",
    ]);
    expect(catalogWarnings(loaded.catalog)).toEqual([
      "risks[1].id 'acme.uncategorized-write' is the fallback by convention only — set fallback: true on it",
    ]);
    // Flagged : silent.
    expect(catalogWarnings(validateCatalog(doc()).catalog)).toEqual([]);
  });

  test('a catalog with a presets key does not load, whatever its value', () => {
    for (const presets of [[], [{ id: 'reader' }], null]) {
      expect(issuesOf(() => validateCatalog(doc({ presets })))).toEqual([RETIRED_PRESETS_ISSUE]);
    }
    expect(RETIRED_PRESETS_ISSUE).toMatch(
      /presets were retired \(ADR macro-actions-and-trust-levels-prefill-the-policy\) ; group the risks in macro_actions/,
    );
    // A catalog built in code is held to it too (`definePlugin`, the registry).
    const built = { ...validateCatalog(doc()).catalog, presets: [] } as RiskCatalog;
    expect(semanticIssues(built)).toEqual([RETIRED_PRESETS_ISSUE]);
  });

  test('a wildcard or a sentinel in a macro-action entry names no risk', () => {
    const d = doc();
    (d.macro_actions as Array<{ entries: unknown[] }>)[0]!.entries.push(
      { risk_id: 'acme.*', quota: 1, rate_limit: { max: 1, window_seconds: 1 } },
      { risk_id: 'all', quota: 1, rate_limit: { max: 1, window_seconds: 1 } },
    );
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      "macro_actions[0].entries[1].risk_id 'acme.*' is not an unqualified risk of the 'acme' catalog",
      "macro_actions[0].entries[2].risk_id 'all' is not an unqualified risk of the 'acme' catalog",
    ]);
  });

  test('a base budget must be explicit positive integers', () => {
    const d = doc();
    (d.macro_actions as Array<{ entries: Record<string, unknown>[] }>)[0]!.entries[0] = {
      risk_id: 'acme.read-things',
      quota: 0,
      rate_limit: { max: 1.5, window_seconds: 'x' },
    };
    const issues = issuesOf(() => validateCatalog(d));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /macro_actions\[0\]\.entries\[0\]\.quota: expected a positive integer/,
        ),
        expect.stringMatching(/rate_limit\.max: expected a positive integer/),
        expect.stringMatching(/rate_limit\.window_seconds: expected a positive integer/),
      ]),
    );
  });

  test('an unknown key inside rate_limit is reported at its path', () => {
    const d = doc();
    (d.macro_actions as Array<{ entries: Record<string, unknown>[] }>)[0]!.entries[0]!.rate_limit =
      { max: 1, window_seconds: 60, burst: 5 };
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'macro_actions[0].entries[0].rate_limit.burst: unknown key',
    ]);
  });

  test('a risk repeated inside one macro-action', () => {
    const d = doc();
    (d.macro_actions as Array<{ entries: unknown[] }>)[0]!.entries.push({
      risk_id: 'acme.read-things',
      quota: 1,
      rate_limit: { max: 1, window_seconds: 1 },
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      "macro_actions[0].entries[1].risk_id 'acme.read-things' already belongs to macro-action 'read'",
    ]);
  });

  test('caps and infra_limits : known keys, positive integers, typed result', () => {
    const ok = doc();
    (ok.risks as Record<string, unknown>[])[0]!.caps = {
      items_per_call_max: 50,
      temporal_window_days: 7,
    };
    (ok.risks as Record<string, unknown>[])[0]!.infra_limits = {
      bytes_per_call_max: 1024,
      calls_per_minute_max: 30,
      calls_per_session_max: 5,
    };
    const loaded = validateCatalog(ok).catalog.risks[0]!;
    expect(loaded.caps).toEqual({ items_per_call_max: 50, temporal_window_days: 7 });
    expect(loaded.infra_limits).toEqual({
      bytes_per_call_max: 1024,
      calls_per_minute_max: 30,
      calls_per_session_max: 5,
    });
    // An empty mapping is kept as an empty mapping.
    const empty = doc();
    (empty.risks as Record<string, unknown>[])[0]!.caps = {};
    expect(validateCatalog(empty).catalog.risks[0]!.caps).toEqual({});

    const bad = doc();
    (bad.risks as Record<string, unknown>[])[0]!.caps = {
      items_per_call_max: -5,
      pages_max: 3,
      bytes_per_call_max: null,
    };
    (bad.risks as Record<string, unknown>[])[0]!.infra_limits = { calls_per_minute_max: 0 };
    (bad.risks as Record<string, unknown>[])[1]!.caps = [1];
    expect(issuesOf(() => validateCatalog(bad))).toEqual([
      'risks[0].caps.pages_max: unknown key',
      'risks[0].caps.items_per_call_max: expected a positive integer',
      'risks[0].caps.bytes_per_call_max: expected a positive integer',
      'risks[0].infra_limits.calls_per_minute_max: expected a positive integer',
      'risks[1].caps: expected a mapping',
    ]);
  });

  test('replaced_by, catalog_version, catalog_date and an empty matches list', () => {
    const d = doc({ catalog_version: 0, catalog_date: '13 October 2026' });
    (d.risks as Record<string, unknown>[])[0]!.replaced_by = 'Not An Id';
    (d.risks as Record<string, unknown>[])[1]!.matches = [];
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'catalog_version: expected a positive integer',
      'catalog_date: expected an ISO date (YYYY-MM-DD)',
      'risks[0].replaced_by: expected a RiskId',
      'risks[1].matches: expected a slice pattern or a non-empty list of patterns',
    ]);
    const ok = doc({ catalog_version: 2, catalog_date: '2026-10-13' });
    (ok.risks as Record<string, unknown>[])[0]!.replaced_by = 'acme.thing-write';
    const loaded = validateCatalog(ok).catalog;
    expect(loaded.catalog_version).toBe(2);
    expect(loaded.catalog_date).toBe('2026-10-13');
    expect(loaded.risks[0]!.replaced_by).toBe('acme.thing-write');
  });

  test('the retired persistence axis is refused like any unknown key, with a hint (SDK 0.9)', () => {
    const d = doc();
    ((d.risks as Record<string, unknown>[])[0]!.vector as Record<string, unknown>).persistence =
      'stateless';
    (d.risks as Record<string, unknown>[])[1]!.vector_overrides = {
      prod: { persistence: 'posture' },
    };
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'risks[0].vector.persistence: unknown axis (retired on 2026-11-13, spec gateway-risk-model §4.2: remove the line)',
      'risks[1].vector_overrides.prod.persistence: unknown axis (retired on 2026-11-13, spec gateway-risk-model §4.2: remove the line)',
    ]);
  });

  test('a vector must name its five axes ; an override may name a subset', () => {
    const d = doc();
    delete ((d.risks as Record<string, unknown>[])[0]!.vector as Record<string, unknown>).cost;
    (d.risks as Record<string, unknown>[])[1]!.vector_overrides = {
      prod: { blast: 'account' },
      Prod: { blast: 'planet', colour: 'red' },
    };
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'risks[0].vector.cost: missing (one of free | moderate | unbounded)',
      'risks[1].vector_overrides.Prod: invalid env label',
      'risks[1].vector_overrides.Prod.blast: expected one of single | env | account | bulk',
      'risks[1].vector_overrides.Prod.colour: unknown axis',
    ]);
  });

  test('a deprecated risk needs no macro-action', () => {
    const d = doc();
    (d.risks as unknown[]).push({ ...risk('acme.old', 'acme.space[**].old.R'), deprecated: true });
    expect(() => validateCatalog(d)).not.toThrow();
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

  test('service slug and top-level shape', () => {
    expect(issuesOf(() => validateCatalog('nope'))).toEqual([
      expect.stringMatching(/expected a mapping/),
    ]);
    expect(issuesOf(() => validateCatalog(doc({ service: 'Acme_Co' }))).join('\n')).toMatch(
      /service: expected a lowercase slug/,
    );
    expect(issuesOf(() => validateCatalog(doc({ risks: [] }))).join('\n')).toMatch(
      /risks: expected a non-empty list/,
    );
  });

  test('YAML syntax errors surface as a CatalogError naming the source', () => {
    const err = (() => {
      try {
        parseCatalogYaml('service: [unclosed', { source: 'broken.yaml' });
      } catch (e) {
        return e as CatalogError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(CatalogError);
    expect(err!.source).toBe('broken.yaml');
    expect(err!.issues[0]).toMatch(/^YAML syntax:/);
  });

  test.each([
    ['a JS function', 'service: !!js/function "function () { return 1 }"'],
    ['a JS regexp', 'service: !!js/regexp /x/'],
    ['a custom local tag', 'service: !acme vercel'],
    ['a YAML 1.1 binary', 'service: !!binary AAAA'],
    ['a complex mapping key', '? [service]\n: vercel'],
  ])('%s is refused as a YAML syntax error, never constructed', (_label, text) => {
    expect(issuesOf(() => parseCatalogYaml(text))[0]).toMatch(/^YAML syntax:/);
  });
});

describe('isCompleteVector', () => {
  const full = {
    reversibility: 'reversible',
    blast: 'single',
    data: 'data',
    cost: 'free',
    visibility: 'internal',
  } as const;

  test('true only when the five axes are set', () => {
    expect(isCompleteVector(full)).toBe(true);
    expect(isCompleteVector({})).toBe(false);
    expect(isCompleteVector({ ...full, visibility: undefined })).toBe(false);
  });
});

describe('wildcardIssues', () => {
  const base = validateCatalog(doc()).catalog;
  const catalog: RiskCatalog = {
    ...base,
    risks: [...base.risks, { ...base.risks[0]!, id: 'acme.read-*' }],
  };

  test('reports the risk ids that are patterns', () => {
    expect(riskIdWildcardIssues(catalog)).toEqual([
      "risks[3].id 'acme.read-*' contains a wildcard",
    ]);
    expect(wildcardIssues(catalog)).toEqual(riskIdWildcardIssues(catalog));
  });
});

describe('macro-actions', () => {
  const action = (id: string, riskIds: string[]) => ({
    id,
    label: id,
    description: id,
    entries: riskIds.map((risk_id) => ({
      risk_id,
      quota: 10,
      rate_limit: { max: 5, window_seconds: 60 },
    })),
  });

  test('none declared is an error, unless disabled', () => {
    const d = doc({ macro_actions: [] });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'macro_actions: every catalog groups its risks into macro-actions (ADR macro-actions-and-trust-levels-prefill-the-policy)',
    ]);
    expect(() => validateCatalog(d, { requireMacroActions: false })).not.toThrow();
  });

  test('every named risk in exactly one, never the fallback, never a qualified or foreign id', () => {
    const d = doc({
      macro_actions: [
        action('read', ['acme.read-things', 'acme.uncategorized-write']),
        action('again', ['acme.read-things', 'acme.thing-write[prod]', 'other.read-things']),
      ],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      "macro_actions[0].entries[1].risk_id 'acme.uncategorized-write' is the fallback, which belongs to no macro-action",
      "macro_actions[1].entries[0].risk_id 'acme.read-things' already belongs to macro-action 'read'",
      "macro_actions[1].entries[1].risk_id 'acme.thing-write[prod]' is not an unqualified risk of the 'acme' catalog",
      "macro_actions[1].entries[2].risk_id 'other.read-things' is not an unqualified risk of the 'acme' catalog",
      "risks: 'acme.thing-write' belongs to no macro-action",
    ]);
  });

  test('an empty macro-action, a gate or a bad budget is a structural error', () => {
    const d = doc({
      macro_actions: [
        action('read', ['acme.read-things']),
        action('empty', []),
        {
          ...action('write', []),
          entries: [
            {
              risk_id: 'acme.thing-write',
              quota: 0,
              rate_limit: { max: 5, window_seconds: 60 },
              gate: 'auto',
            },
          ],
        },
      ],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'macro_actions[1].entries: expected a non-empty list',
      'macro_actions[2].entries[0].gate: unknown key',
      'macro_actions[2].entries[0].quota: expected a positive integer (no infinite budget, spec §3.2)',
    ]);
  });

  test('the reserved id and a repeated id', () => {
    const d = doc({
      macro_actions: [
        action('anything-else', ['acme.read-things']),
        action('anything-else', ['acme.thing-write']),
      ],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      "macro_actions[0].id 'anything-else' is the gateway's own macro-action for the fallback",
      "macro_actions[1].id 'anything-else' is the gateway's own macro-action for the fallback",
      "macro_actions[1].id 'anything-else' is declared twice",
    ]);
  });

  test('a narrative is optional and read trimmed', () => {
    const narrative = '  Reads things. Nothing is written.\n';
    const d = doc({
      macro_actions: [
        { ...action('read', ['acme.read-things']), narrative },
        action('write', ['acme.thing-write']),
      ],
    });
    const actions = validateCatalog(d).catalog.macro_actions;
    expect(actions[0]!.narrative).toBe('Reads things. Nothing is written.');
    expect(actions[1]).not.toHaveProperty('narrative');
  });

  test('a narrative that is not a string of at most 600 characters refuses the catalog', () => {
    const d = doc({
      macro_actions: [
        {
          ...action('read', ['acme.read-things']),
          narrative: 'x'.repeat(NARRATIVE_MAX_LENGTH + 1),
        },
        { ...action('write', ['acme.thing-write']), narrative: 42 },
      ],
    });
    expect(issuesOf(() => validateCatalog(d))).toEqual([
      'macro_actions[0].narrative: 601 characters, at most 600 (spec §4.6)',
      'macro_actions[1].narrative: expected a non-empty string',
    ]);
    const blank = doc({
      macro_actions: [
        { ...action('read', ['acme.read-things']), narrative: '   ' },
        action('write', ['acme.thing-write']),
      ],
    });
    expect(issuesOf(() => validateCatalog(blank))).toEqual([
      'macro_actions[0].narrative: expected a non-empty string',
    ]);
  });

  test('a narrative of exactly 600 characters is accepted', () => {
    const d = doc({
      macro_actions: [
        { ...action('read', ['acme.read-things']), narrative: 'x'.repeat(NARRATIVE_MAX_LENGTH) },
        action('write', ['acme.thing-write']),
      ],
    });
    expect(validateCatalog(d).catalog.macro_actions[0]!.narrative).toHaveLength(
      NARRATIVE_MAX_LENGTH,
    );
  });

  test('the acme fixture reads its macro-actions with their base budgets', () => {
    expect(parseCatalogYaml(fixtureText).catalog.macro_actions.map((a) => a.id)).toEqual([
      'read',
      'write',
    ]);
  });
});
