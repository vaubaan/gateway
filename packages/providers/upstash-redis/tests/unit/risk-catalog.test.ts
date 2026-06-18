/**
 * Catalog lint — parses the YAML, validates the static schema, parses every
 * `matches` slice pattern, and walks every MCP tool exposed by the provider
 * to assert that AT LEAST ONE non-fallback risk matches at least one of the
 * tool's emitted slices.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import yaml from 'js-yaml';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';
import { matches, parseSlice } from '@vaubaan/policy-engine';

import { availableTools as upstashRedisAvailableTools } from '../../src/tools.ts';
import { classifyUpstashRedisV4 } from '../../src/risk-classifier.ts';

// ─── Load + parse the YAML catalog ──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const rawYaml = readFileSync(yamlPath, 'utf8');
const parsedCatalog = yaml.load(rawYaml) as RiskCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'upstash-redis',
  resource_ref: 'db-abc-123',
  display_name: null,
  created_at: '2026-01-01',
};

const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9-]*)?(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('upstash-redis risk-catalog — YAML structural validation', () => {
  test('YAML parses into a valid RiskCatalog shape', () => {
    expect(parsedCatalog.provider).toBe('upstash-redis');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    expect(parsedCatalog.risks.length).toBeGreaterThanOrEqual(10);
  });

  test('every entry declares the required fields', () => {
    for (const entry of parsedCatalog.risks) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(typeof entry.matches).toBe('string');
      expect(entry.vector).toBeDefined();
    }
  });

  test('every RiskId matches the wire-format regex', () => {
    for (const entry of parsedCatalog.risks) {
      expect(entry.id, `risk id '${entry.id}' must match RISK_ID_REGEX`).toMatch(RISK_ID_REGEX);
    }
  });

  test('RiskIds are unique', () => {
    const seen = new Set<string>();
    for (const entry of parsedCatalog.risks) {
      expect(seen.has(entry.id), `duplicate risk id '${entry.id}'`).toBe(false);
      seen.add(entry.id);
    }
  });

  test('every 6D vector axis carries a valid value', () => {
    const axes: Record<keyof RiskEntry['vector'], readonly string[]> = {
      reversibility: ['reversible', 'costly', 'irreversible'],
      blast: ['single', 'env', 'account', 'bulk'],
      data: ['metadata', 'data', 'secret', 'pii'],
      cost: ['free', 'moderate', 'unbounded'],
      visibility: ['internal', 'team', 'public'],
      persistence: ['stateless', 'session', 'posture'],
    };
    for (const entry of parsedCatalog.risks) {
      for (const [axis, allowed] of Object.entries(axes) as Array<
        [keyof RiskEntry['vector'], readonly string[]]
      >) {
        expect(
          allowed,
          `risk '${entry.id}' axis '${axis}' has invalid value '${entry.vector[axis]}'`,
        ).toContain(entry.vector[axis]);
      }
    }
  });

  test('a fallback entry (uncategorized-*) is declared', () => {
    const hasFallback = parsedCatalog.risks.some((e) =>
      e.id.startsWith('upstash-redis.uncategorized'),
    );
    expect(hasFallback, 'catalog must declare an upstash-redis.uncategorized-* fallback').toBe(
      true,
    );
  });
});

describe('upstash-redis risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('upstash-redis');
      }
    });
  }
});

// ─── Build the parsed-pattern index once for lint usage ─────────────────────

const indexed = parsedCatalog.risks.map((entry) => ({
  entry,
  pattern: parseSlice(typeof entry.matches === 'string' ? entry.matches : entry.matches[0]!),
}));

const FALLBACK_ID = 'upstash-redis.uncategorized-write';

/** Synthetic args for each tool to exercise coverage. */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  const base = { databaseId: 'db-abc-123' } as const;
  switch (tool) {
    case 'upstash_redis__list_databases':
      return [{}];
    case 'upstash_redis__get_database':
      return [base];
    case 'upstash_redis__create_database':
      return [{ name: 'test', region: 'us-east-1' }];
    case 'upstash_redis__delete_database':
      return [base];
    case 'upstash_redis__rename_database':
      return [{ ...base, name: 'new-name' }];
    case 'upstash_redis__get_database_stats':
      return [base];
    case 'upstash_redis__execute':
      return [
        { ...base, command: ['GET', 'k'] },
        { ...base, command: ['SET', 'k', 'v'] },
        { ...base, command: ['FLUSHDB'] },
        { ...base, command: ['UNKNOWN_CMD'] },
      ];
    case 'upstash_redis__get':
      return [{ ...base, key: 'mykey' }];
    case 'upstash_redis__set':
      return [{ ...base, key: 'mykey', value: 'v' }];
    case 'upstash_redis__del':
      return [{ ...base, keys: ['k1'] }];
    case 'upstash_redis__keys':
      return [{ ...base, pattern: '*' }];
    case 'upstash_redis__scan':
      return [{ ...base, cursor: 0 }];
    case 'upstash_redis__ttl':
      return [{ ...base, key: 'mykey' }];
    case 'upstash_redis__expire':
      return [{ ...base, key: 'mykey', seconds: 60 }];
    case 'upstash_redis__hset':
      return [{ ...base, key: 'myhash', fields: { f: 'v' } }];
    case 'upstash_redis__hgetall':
      return [{ ...base, key: 'myhash' }];
    case 'upstash_redis__lpush':
      return [{ ...base, key: 'mylist', values: ['a'] }];
    case 'upstash_redis__lrange':
      return [{ ...base, key: 'mylist', start: 0, stop: -1 }];
    case 'upstash_redis__sadd':
      return [{ ...base, key: 'myset', members: ['x'] }];
    case 'upstash_redis__smembers':
      return [{ ...base, key: 'myset' }];
    case 'upstash_redis__dbsize':
      return [base];
    default:
      return [base];
  }
}

/** Concrete slices the classifier emits for a tool. */
function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyUpstashRedisV4(tool, args, [binding]);
    if ('slices' in result) out.push(...result.slices);
  }
  return out;
}

/** RiskIds matching at least one slice. */
function risksForTool(tool: string): string[] {
  const sl = slicesForTool(tool);
  const matched = new Set<string>();
  for (const s of sl) {
    for (const { entry, pattern } of indexed) {
      if (matches(pattern, s)) matched.add(entry.id);
    }
  }
  return [...matched];
}

describe('upstash-redis risk-catalog — coverage lint (every tool matched by >=1 non-fallback risk)', () => {
  for (const tool of upstashRedisAvailableTools) {
    test(`'${tool.name}' is covered by at least one non-fallback risk`, () => {
      const hit = risksForTool(tool.name);
      expect(hit.length, `tool '${tool.name}' matched zero catalog risks`).toBeGreaterThan(0);
      const nonFallback = hit.filter((id) => id !== FALLBACK_ID);
      expect(
        nonFallback.length,
        `tool '${tool.name}' is only covered by the fallback ${FALLBACK_ID} — add a specific risk`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('upstash-redis risk-catalog — saliency checks', () => {
  test('read-database-metadata entry exists', () => {
    expect(
      parsedCatalog.risks.find((r) => r.id === 'upstash-redis.read-database-metadata'),
    ).toBeDefined();
  });

  test('read-data entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.read-data')).toBeDefined();
  });

  test('write-data entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.write-data')).toBeDefined();
  });

  test('delete-data entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.delete-data')).toBeDefined();
  });

  test('flush-database entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.flush-database')).toBeDefined();
  });

  test('execute-arbitrary entry exists', () => {
    expect(
      parsedCatalog.risks.find((r) => r.id === 'upstash-redis.execute-arbitrary'),
    ).toBeDefined();
  });

  test('create-database entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.create-database')).toBeDefined();
  });

  test('delete-database entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.delete-database')).toBeDefined();
  });

  test('modify-database entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.modify-database')).toBeDefined();
  });

  test('read-stats entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'upstash-redis.read-stats')).toBeDefined();
  });

  test('fallback entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === FALLBACK_ID)).toBeDefined();
  });
});
