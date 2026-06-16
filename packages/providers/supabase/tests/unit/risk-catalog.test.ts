/**
 * Tests for the v4 Supabase risk catalog.
 *
 * Coverage : parses the YAML, validates the `RiskCatalog` shape, exercises
 * `parseSlice` on every `matches` pattern, and lints coverage —
 *
 *   - every tool emits at least one slice that matches at least one risk
 *     other than the fallback (no tool should fall ONLY on
 *     `supabase.uncategorized-write`),
 *   - `row[one]` and `row[bulk]` markers fire the right (and only the right)
 *     write risks (mutual exclusion),
 *   - posture-sensitive entries (`policy.W`, `auth-config.W`,
 *     `function-secret.W`, …) are declared in the catalog,
 *   - the fallback `supabase.**.W` is present and covers any naïve write.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  indexCatalog,
  parseSlice,
  risksTouchedByAll,
  serializeSlice,
} from '@vaubaan/policy-engine';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';

import { classifySupabaseV4, SUPPORTED_TOOLS } from '../../src/risk-classifier.ts';

// ── load the catalog once ───────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const RAW: unknown = parseYaml(readFileSync(yamlPath, 'utf8'));

function asCatalog(raw: unknown): RiskCatalog {
  if (!raw || typeof raw !== 'object') {
    throw new Error('catalog YAML did not parse to an object');
  }
  return raw as RiskCatalog;
}

const CATALOG = asCatalog(RAW);
const INDEXED = indexCatalog(CATALOG);

// ── small helpers ───────────────────────────────────────────────────────

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';
const stagingBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'supabase',
  resource_ref: STAGING_REF,
  display_name: null,
  environment: 'staging',
  created_at: '2026-01-01T00:00:00Z',
};

function risksFor(tool: string, args: Record<string, unknown>): string[] {
  const r = classifySupabaseV4(tool, args, [stagingBinding]);
  if ('denied' in r) {
    throw new Error(`${tool} denied: ${r.denied}`);
  }
  return risksTouchedByAll(r.slices, INDEXED);
}

// ────────────────────────────────────────────────────────────────────────
// Schema / parse-ability
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — parse + schema', () => {
  test('declares provider `supabase`', () => {
    expect(CATALOG.provider).toBe('supabase');
  });

  test('exposes a non-empty `risks` array', () => {
    expect(Array.isArray(CATALOG.risks)).toBe(true);
    expect(CATALOG.risks.length).toBeGreaterThan(20);
  });

  test('every entry has the required fields', () => {
    for (const e of CATALOG.risks) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.label).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(typeof e.matches === 'string' || Array.isArray(e.matches)).toBe(true);
      // 6-dim vector
      expect(e.vector).toBeDefined();
      expect(typeof e.vector.reversibility).toBe('string');
      expect(typeof e.vector.blast).toBe('string');
      expect(typeof e.vector.data).toBe('string');
      expect(typeof e.vector.cost).toBe('string');
      expect(typeof e.vector.visibility).toBe('string');
      expect(typeof e.vector.persistence).toBe('string');
    }
  });

  test('all `id`s are unique and start with `supabase.`', () => {
    const ids = new Set<string>();
    for (const e of CATALOG.risks) {
      expect(e.id.startsWith('supabase.')).toBe(true);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });

  test('every `matches` pattern parses (via slice-dsl)', () => {
    // indexCatalog already parses every entry — but assert explicitly
    // so a regression surfaces clearly.
    for (const e of CATALOG.risks) {
      const patterns: readonly string[] = typeof e.matches === 'string' ? [e.matches] : e.matches;
      for (const p of patterns) {
        expect(() => parseSlice(p)).not.toThrow();
      }
    }
  });

  test('every parsed pattern is rooted on provider `supabase` and ends in R or W', () => {
    for (const { entry, patterns } of INDEXED.entries) {
      for (const pattern of patterns) {
        expect(pattern.provider).toBe('supabase');
        expect(['R', 'W']).toContain(pattern.action);
      }
      expect(entry).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Posture-sensitive entries — these specific risks MUST be present in the
// catalog (they used to carry `default_gate=deny` ; post drop-confirm
// they are simply non-default, opt-in only, severity captured by the
// 6D vector — but the catalog must still list them).
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — posture-sensitive entries', () => {
  const REQUIRED_ENTRIES = [
    'supabase.policy-write',
    'supabase.auth-config-write',
    'supabase.function-secret-write',
    'supabase.sso-provider-write',
    'supabase.third-party-auth-write',
    'supabase.storage-config-write',
    'supabase.auth.bulk-user-write',
    'supabase.db-role-write',
    'supabase.extension-write',
  ];
  for (const id of REQUIRED_ENTRIES) {
    test(`${id} entry exists`, () => {
      const e = CATALOG.risks.find((r: RiskEntry) => r.id === id);
      expect(e, `entry ${id} missing from catalog`).toBeDefined();
    });
  }

  test('bulk-row-write is acceptable_in_envs strictly preview+staging', () => {
    const e = CATALOG.risks.find((r: RiskEntry) => r.id === 'supabase.bulk-row-write');
    expect(e?.acceptable_in_envs).toEqual(['preview', 'staging']);
  });

  test('storage.bulk-object-write is acceptable_in_envs strictly preview+staging', () => {
    const e = CATALOG.risks.find((r: RiskEntry) => r.id === 'supabase.storage.bulk-object-write');
    expect(e?.acceptable_in_envs).toEqual(['preview', 'staging']);
  });

  test('fallback `supabase.uncategorized-write` is present', () => {
    const e = CATALOG.risks.find((r: RiskEntry) => r.id === 'supabase.uncategorized-write');
    expect(e).toBeDefined();
    expect(e!.matches).toBe('supabase.**.W');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Coverage lint — every tool fires ≥ 1 named risk (not just fallback)
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — coverage lint', () => {
  /** Build canned args so each tool produces a well-shaped slice for
   *  matching. We don't need real values — just enough to populate the
   *  identifier segments. */
  const cannedArgs: Record<string, Record<string, unknown>> = {
    supabase__get_project: { project_ref: STAGING_REF },
    supabase__get_anon_key: { project_ref: STAGING_REF },
    supabase__list_tables: { project_ref: STAGING_REF },
    supabase__list_migrations: { project_ref: STAGING_REF },
    supabase__get_advisors: { project_ref: STAGING_REF },
    supabase__apply_migration: {
      project_ref: STAGING_REF,
      name: 'm',
      query: 'CREATE TABLE x(id int);',
    },
    supabase__execute_sql: { project_ref: STAGING_REF, query: 'select 1' },
    supabase__list_buckets: { project_ref: STAGING_REF },
    supabase__get_storage_config: { project_ref: STAGING_REF },
    supabase__update_storage_config: { project_ref: STAGING_REF },
    supabase__create_bucket: { project_ref: STAGING_REF, id: 'b1', name: 'B1' },
    supabase__update_bucket: { project_ref: STAGING_REF, id: 'b1' },
    supabase__delete_bucket: { project_ref: STAGING_REF, id: 'b1' },
    supabase__list_objects: { project_ref: STAGING_REF, bucket: 'b1' },
    supabase__upload_object: {
      project_ref: STAGING_REF,
      bucket: 'b1',
      path: 'p.txt',
      content_base64: 'AA',
    },
    supabase__delete_object: { project_ref: STAGING_REF, bucket: 'b1', path: 'p.txt' },
    supabase__create_signed_url: { project_ref: STAGING_REF, bucket: 'b1', path: 'p.txt' },
    supabase__get_auth_config: { project_ref: STAGING_REF },
    supabase__update_auth_config: { project_ref: STAGING_REF, config: {} },
    supabase__list_sso_providers: { project_ref: STAGING_REF },
    supabase__get_sso_provider: { project_ref: STAGING_REF, provider_id: 'sso1' },
    supabase__create_sso_provider: { project_ref: STAGING_REF, type: 'saml' },
    supabase__update_sso_provider: { project_ref: STAGING_REF, provider_id: 'sso1' },
    supabase__delete_sso_provider: { project_ref: STAGING_REF, provider_id: 'sso1' },
    supabase__list_third_party_auth: { project_ref: STAGING_REF },
    supabase__get_third_party_auth: { project_ref: STAGING_REF, tpa_id: 't1' },
    supabase__create_third_party_auth: { project_ref: STAGING_REF, type: 'oidc' },
    supabase__delete_third_party_auth: { project_ref: STAGING_REF, tpa_id: 't1' },
    supabase__list_users: { project_ref: STAGING_REF },
    supabase__get_user: { project_ref: STAGING_REF, user_id: 'u1' },
    supabase__create_user: { project_ref: STAGING_REF, email: 'a@b.c' },
    supabase__update_user: { project_ref: STAGING_REF, user_id: 'u1' },
    supabase__delete_user: { project_ref: STAGING_REF, user_id: 'u1' },
    supabase__generate_link: {
      project_ref: STAGING_REF,
      email: 'a@b.c',
      type: 'magiclink',
    },
    supabase__list_functions: { project_ref: STAGING_REF },
    supabase__get_function: { project_ref: STAGING_REF, function_slug: 'fn1' },
    supabase__get_function_body: { project_ref: STAGING_REF, function_slug: 'fn1' },
    supabase__list_function_secrets: { project_ref: STAGING_REF },
    supabase__create_function: { project_ref: STAGING_REF, slug: 'fn1', body: '…' },
    supabase__update_function: { project_ref: STAGING_REF, function_slug: 'fn1' },
    supabase__delete_function: { project_ref: STAGING_REF, function_slug: 'fn1' },
    supabase__deploy_function: {
      project_ref: STAGING_REF,
      slug: 'fn1',
      entrypoint_path: 'index.ts',
      files: [{ name: 'index.ts', content: '…' }],
    },
    supabase__create_function_secrets: {
      project_ref: STAGING_REF,
      secrets: [{ name: 'K', value: 'v' }],
    },
    supabase__delete_function_secrets: { project_ref: STAGING_REF, names: ['K'] },
  };

  test('every supported tool has canned args wired in this test', () => {
    for (const tool of SUPPORTED_TOOLS) {
      expect(cannedArgs[tool], `missing canned args for ${tool}`).toBeDefined();
    }
  });

  test('every supported tool fires ≥1 named risk (not just fallback)', () => {
    for (const tool of SUPPORTED_TOOLS) {
      const args = cannedArgs[tool]!;
      const touched = risksFor(tool, args);
      // every tool must touch at least one risk
      expect(touched.length, `${tool} touched no risk at all`).toBeGreaterThan(0);
      // and at least one of them must be more specific than the fallback
      const named = touched.filter((id) => id !== 'supabase.uncategorized-write');
      expect(
        named.length,
        `${tool} only fired the fallback ; missing specific catalog entry`,
      ).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Mutual exclusion : row[one] vs row[bulk], user[one] vs user[bulk]
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — cardinality mutual exclusion', () => {
  /** Build a row-write concrete slice with the given cardinality marker. */
  function rowSlice(card: 'one' | 'bulk'): Slice {
    return parseSlice(
      `supabase.project[${STAGING_REF}].schema[public].table[users].row[${card}].W`,
    );
  }

  test('row[one].W fires row-write-one but NOT bulk-row-write', () => {
    const touched = risksTouchedByAll([rowSlice('one')], INDEXED);
    expect(touched).toContain('supabase.row-write-one');
    expect(touched).not.toContain('supabase.bulk-row-write');
    // fallback always co-fires
    expect(touched).toContain('supabase.uncategorized-write');
  });

  test('row[bulk].W fires bulk-row-write but NOT row-write-one', () => {
    const touched = risksTouchedByAll([rowSlice('bulk')], INDEXED);
    expect(touched).toContain('supabase.bulk-row-write');
    expect(touched).not.toContain('supabase.row-write-one');
  });

  test('user[one].W fires auth.user-write-one but NOT auth.bulk-user-write', () => {
    const slc = parseSlice(`supabase.project[${STAGING_REF}].user[one].W`);
    const touched = risksTouchedByAll([slc], INDEXED);
    expect(touched).toContain('supabase.auth.user-write-one');
    expect(touched).not.toContain('supabase.auth.bulk-user-write');
  });

  test('user[bulk].W fires auth.bulk-user-write but NOT auth.user-write-one', () => {
    const slc = parseSlice(`supabase.project[${STAGING_REF}].user[bulk].W`);
    const touched = risksTouchedByAll([slc], INDEXED);
    expect(touched).toContain('supabase.auth.bulk-user-write');
    expect(touched).not.toContain('supabase.auth.user-write-one');
  });

  test('object[one].W fires storage.object-write-one but NOT storage.bulk-object-write', () => {
    const slc = parseSlice(`supabase.project[${STAGING_REF}].bucket[avatars].object[one].W`);
    const touched = risksTouchedByAll([slc], INDEXED);
    expect(touched).toContain('supabase.storage.object-write-one');
    expect(touched).not.toContain('supabase.storage.bulk-object-write');
  });

  test('object[bulk].W fires storage.bulk-object-write but NOT storage.object-write-one', () => {
    const slc = parseSlice(`supabase.project[${STAGING_REF}].bucket[avatars].object[bulk].W`);
    const touched = risksTouchedByAll([slc], INDEXED);
    expect(touched).toContain('supabase.storage.bulk-object-write');
    expect(touched).not.toContain('supabase.storage.object-write-one');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Decision-level spot checks for high-impact tools (research §5)
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — decision-level spot checks', () => {
  test('update_auth_config fires auth-config.W', () => {
    const touched = risksFor('supabase__update_auth_config', {
      project_ref: STAGING_REF,
      config: {},
    });
    expect(touched).toContain('supabase.auth-config-write');
    const entry = CATALOG.risks.find((r: RiskEntry) => r.id === 'supabase.auth-config-write');
    expect(entry).toBeDefined();
  });

  test('create_function_secrets fires function-secret.W (deny posture)', () => {
    const touched = risksFor('supabase__create_function_secrets', {
      project_ref: STAGING_REF,
      secrets: [{ name: 'STRIPE_KEY', value: 'sk_…' }],
    });
    expect(touched).toContain('supabase.function-secret-write');
  });

  test('apply_migration with CREATE POLICY fires policy.W (deny posture)', () => {
    const touched = risksFor('supabase__apply_migration', {
      project_ref: STAGING_REF,
      name: 'rls',
      query: 'CREATE POLICY p ON users FOR ALL USING (true);',
    });
    expect(touched).toContain('supabase.policy-write');
    expect(touched).toContain('supabase.migration-write');
  });

  test('execute_sql with mutating-looking SQL still only fires read-data', () => {
    const touched = risksFor('supabase__execute_sql', {
      project_ref: STAGING_REF,
      query: 'DELETE FROM users WHERE 1=1;',
    });
    expect(touched).toContain('supabase.read-data');
    // critically : no W risk fires from execute_sql (security is enforced
    // by Postgres READ ONLY ; classifier emits only the R slice).
    expect(touched.every((r) => !r.endsWith('.W') && r !== 'supabase.uncategorized-write')).toBe(
      true,
    );
  });

  test('create_signed_url fires signed-url.R (confirm), not the bare read-only', () => {
    const touched = risksFor('supabase__create_signed_url', {
      project_ref: STAGING_REF,
      bucket: 'avatars',
      path: 'u/123.png',
    });
    expect(touched).toContain('supabase.storage.signed-url-read');
    expect(touched).toContain('supabase.storage.object-read'); // co-fire
    expect(touched).toContain('supabase.read-data'); // broad pattern co-fire
  });

  // smoke check : we can re-serialize and re-parse every pattern
  test('parse → serialize → parse is stable for every pattern', () => {
    for (const e of CATALOG.risks) {
      const patterns: readonly string[] = typeof e.matches === 'string' ? [e.matches] : e.matches;
      for (const p of patterns) {
        const a = parseSlice(p);
        const reparsed = parseSlice(serializeSlice(a));
        expect(reparsed.provider).toBe(a.provider);
        expect(reparsed.action).toBe(a.action);
        expect(reparsed.path.length).toBe(a.path.length);
      }
    }
  });
});
