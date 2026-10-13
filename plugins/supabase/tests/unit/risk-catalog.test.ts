/**
 * Tests of the Supabase risk catalog as the plugin loads it.
 *
 * Coverage : the loaded catalog shape, every `matches` pattern parses,
 * coverage lint (every tool fires named risks and never the fallback),
 * cardinality mutual exclusion (`row[one]` vs `row[bulk]`, …),
 * posture-sensitive entries present, decision-level spot checks.
 */

import { describe, expect, test } from 'vitest';

import { parseSlice, risksTouchedByAll, serializeSlice } from '@vaubaan/policy-engine';
import type { Resource, RiskEntry, Slice } from '@vaubaan/plugin-sdk';

import { classifySupabase, SUPABASE_CLASSIFIED_TOOLS, supabaseCatalog } from '../../src/index.ts';

const CATALOG = supabaseCatalog.catalog;
const INDEXED = supabaseCatalog.indexed;

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';
const staging: Resource = {
  provider: 'supabase',
  ref: STAGING_REF,
  env: 'staging',
  displayName: 'Staging',
};

function risksFor(tool: string, args: Record<string, unknown>): string[] {
  const r = classifySupabase(tool, args, [staging]);
  if ('denied' in r) throw new Error(`${tool} denied: ${r.denied}`);
  return risksTouchedByAll(r.slices, INDEXED);
}

const patternsOf = (e: RiskEntry): readonly string[] =>
  typeof e.matches === 'string' ? [e.matches] : e.matches;

// ────────────────────────────────────────────────────────────────────────
// Schema / parse-ability
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — loaded shape', () => {
  test('declares provider `supabase`, a version and a date', () => {
    expect(CATALOG.provider).toBe('supabase');
    expect(CATALOG.catalog_version).toBe(1);
    expect(CATALOG.catalog_date).toBe('2026-10-13');
  });

  test('exposes 24 named risks plus the fallback', () => {
    expect(CATALOG.risks.length).toBe(25);
  });

  test('every entry has the required fields and a 6-axis vector', () => {
    for (const e of CATALOG.risks) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.label).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(typeof e.matches === 'string' || Array.isArray(e.matches)).toBe(true);
      expect(Object.keys(e.vector).sort()).toEqual(
        ['blast', 'cost', 'data', 'persistence', 'reversibility', 'visibility'].sort(),
      );
    }
  });

  test('all ids are unique and start with `supabase.`', () => {
    const ids = new Set<string>();
    for (const e of CATALOG.risks) {
      expect(e.id.startsWith('supabase.')).toBe(true);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });

  test('every `matches` pattern parses and is rooted on `supabase`', () => {
    for (const { entry, patterns } of INDEXED.entries) {
      expect(patterns.length).toBe(patternsOf(entry).length);
      for (const pattern of patterns) {
        expect(pattern.provider).toBe('supabase');
        expect(['R', 'W']).toContain(pattern.action);
      }
    }
  });

  test('every write risk is env-scoped ; reads are account-scoped except auth.read-users', () => {
    for (const e of CATALOG.risks) {
      const writes = patternsOf(e).every((p) => p.endsWith('.W'));
      const envScoped = (e.acceptable_in_envs?.length ?? 0) > 0;
      if (writes) expect(envScoped, `${e.id} should be env-scoped`).toBe(true);
      else
        expect(envScoped, `${e.id} should be account-scoped`).toBe(
          e.id === 'supabase.auth.read-users',
        );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Posture-sensitive entries — must be present (opt-in only, never default)
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
      expect(
        CATALOG.risks.find((r) => r.id === id),
        `entry ${id} missing`,
      ).toBeDefined();
    });
  }

  test('bulk-row-write is acceptable_in_envs strictly preview+staging', () => {
    const e = CATALOG.risks.find((r) => r.id === 'supabase.bulk-row-write');
    expect(e?.acceptable_in_envs).toEqual(['preview', 'staging']);
  });

  test('storage.bulk-object-write is acceptable_in_envs strictly preview+staging', () => {
    const e = CATALOG.risks.find((r) => r.id === 'supabase.storage.bulk-object-write');
    expect(e?.acceptable_in_envs).toEqual(['preview', 'staging']);
  });

  test('fallback `supabase.uncategorized-write` is present and env-scoped', () => {
    const e = CATALOG.risks.find((r) => r.id === 'supabase.uncategorized-write');
    expect(e).toBeDefined();
    expect(e!.matches).toBe('supabase.**.W');
    expect(e!.acceptable_in_envs).toEqual(['preview', 'staging', 'prod']);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Coverage lint — every tool fires named risks, never the fallback
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — coverage lint', () => {
  const p = { project_ref: STAGING_REF };
  const cannedArgs: Record<string, Record<string, unknown>> = {
    supabase__get_project: p,
    supabase__get_anon_key: p,
    supabase__list_tables: p,
    supabase__list_migrations: p,
    supabase__get_advisors: p,
    supabase__apply_migration: { ...p, name: 'm', query: 'CREATE TABLE x(id int);' },
    supabase__execute_sql: { ...p, query: 'select 1' },
    supabase__list_buckets: p,
    supabase__get_storage_config: p,
    supabase__update_storage_config: p,
    supabase__create_bucket: { ...p, id: 'b1', name: 'B1' },
    supabase__update_bucket: { ...p, id: 'b1' },
    supabase__delete_bucket: { ...p, id: 'b1' },
    supabase__list_objects: { ...p, bucket: 'b1' },
    supabase__upload_object: { ...p, bucket: 'b1', path: 'p.txt', content_base64: 'AA' },
    supabase__delete_object: { ...p, bucket: 'b1', path: 'p.txt' },
    supabase__create_signed_url: { ...p, bucket: 'b1', path: 'p.txt' },
    supabase__get_auth_config: p,
    supabase__update_auth_config: { ...p, config: {} },
    supabase__list_sso_providers: p,
    supabase__get_sso_provider: { ...p, provider_id: 'sso1' },
    supabase__create_sso_provider: { ...p, type: 'saml' },
    supabase__update_sso_provider: { ...p, provider_id: 'sso1' },
    supabase__delete_sso_provider: { ...p, provider_id: 'sso1' },
    supabase__list_third_party_auth: p,
    supabase__get_third_party_auth: { ...p, tpa_id: 't1' },
    supabase__create_third_party_auth: { ...p, type: 'oidc' },
    supabase__delete_third_party_auth: { ...p, tpa_id: 't1' },
    supabase__list_users: p,
    supabase__get_user: { ...p, user_id: 'u1' },
    supabase__create_user: { ...p, email: 'a@b.c' },
    supabase__update_user: { ...p, user_id: 'u1' },
    supabase__delete_user: { ...p, user_id: 'u1' },
    supabase__generate_link: { ...p, email: 'a@b.c', type: 'magiclink' },
    supabase__list_functions: p,
    supabase__get_function: { ...p, function_slug: 'fn1' },
    supabase__get_function_body: { ...p, function_slug: 'fn1' },
    supabase__list_function_secrets: p,
    supabase__create_function: { ...p, slug: 'fn1', body: '…' },
    supabase__update_function: { ...p, function_slug: 'fn1' },
    supabase__delete_function: { ...p, function_slug: 'fn1' },
    supabase__deploy_function: {
      ...p,
      slug: 'fn1',
      entrypoint_path: 'index.ts',
      files: [{ name: 'index.ts', content: '…' }],
    },
    supabase__create_function_secrets: { ...p, secrets: [{ name: 'K', value: 'v' }] },
    supabase__delete_function_secrets: { ...p, names: ['K'] },
  };

  test('every classified tool has canned args wired in this test', () => {
    for (const tool of SUPABASE_CLASSIFIED_TOOLS) {
      expect(cannedArgs[tool], `missing canned args for ${tool}`).toBeDefined();
    }
  });

  test('every classified tool fires at least one named risk and never the fallback', () => {
    for (const tool of SUPABASE_CLASSIFIED_TOOLS) {
      const touched = risksFor(tool, cannedArgs[tool]!);
      expect(touched.length, `${tool} touched no risk at all`).toBeGreaterThan(0);
      expect(touched, `${tool} landed on the fallback`).not.toContain(
        'supabase.uncategorized-write',
      );
    }
  });

  test.each<[string, Record<string, unknown>, string[]]>([
    ['supabase__create_user', { email: 'a@b.c' }, ['supabase.auth.user-write-one']],
    ['supabase__update_user', { user_id: 'u1' }, ['supabase.auth.user-write-one']],
    ['supabase__update_user', { user_id: 'bulk' }, ['supabase.auth.user-write-one']],
    ['supabase__delete_user', { user_id: 'u1' }, ['supabase.auth.user-write-one']],
    [
      'supabase__upload_object',
      { bucket: 'b1', path: 'dir/p.txt', content_base64: 'AA' },
      ['supabase.storage.object-write-one'],
    ],
    [
      'supabase__delete_object',
      { bucket: 'b1', path: 'bulk' },
      ['supabase.storage.object-write-one'],
    ],
  ])('%s %o touches exactly %o', (tool, args, expected) => {
    expect(risksFor(tool, { ...p, ...args })).toEqual(expected);
  });

  test.each<[string, string[]]>([
    ['create table t (id int);', ['supabase.migration-write']],
    ['drop table users cascade;', ['supabase.migration-write', 'supabase.bulk-row-write']],
    [
      'grant all on all tables in schema public to anon;',
      ['supabase.migration-write', 'supabase.db-role-write'],
    ],
    ['create extension pg_net;', ['supabase.migration-write', 'supabase.extension-write']],
    [
      "DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM auth.users'; END $$;",
      [
        'supabase.migration-write',
        'supabase.bulk-row-write',
        'supabase.policy-write',
        'supabase.db-role-write',
        'supabase.extension-write',
      ],
    ],
  ])('apply_migration %j touches exactly %o', (query, expected) => {
    expect(risksFor('supabase__apply_migration', { ...p, name: 'm', query })).toEqual(expected);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Mutual exclusion : row[one] vs row[bulk], user[one] vs user[bulk]
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — cardinality mutual exclusion', () => {
  function rowSlice(card: 'one' | 'bulk'): Slice {
    return parseSlice(
      `supabase.project[${STAGING_REF}].schema[public].table[users].row[${card}].W`,
    );
  }

  test('row[one].W fires row-write-one but NOT bulk-row-write', () => {
    const touched = risksTouchedByAll([rowSlice('one')], INDEXED);
    expect(touched).toContain('supabase.row-write-one');
    expect(touched).not.toContain('supabase.bulk-row-write');
    // The fallback is not co-touched by a categorized write (ADR fallback-risk-only-when-uncategorized).
    expect(touched).not.toContain('supabase.uncategorized-write');
  });

  test('row[bulk].W fires bulk-row-write but NOT row-write-one', () => {
    const touched = risksTouchedByAll([rowSlice('bulk')], INDEXED);
    expect(touched).toContain('supabase.bulk-row-write');
    expect(touched).not.toContain('supabase.row-write-one');
  });

  test('user[one].W fires auth.user-write-one but NOT auth.bulk-user-write', () => {
    const touched = risksTouchedByAll(
      [parseSlice(`supabase.project[${STAGING_REF}].user[one].W`)],
      INDEXED,
    );
    expect(touched).toContain('supabase.auth.user-write-one');
    expect(touched).not.toContain('supabase.auth.bulk-user-write');
  });

  test('user[bulk].W fires auth.bulk-user-write but NOT auth.user-write-one', () => {
    const touched = risksTouchedByAll(
      [parseSlice(`supabase.project[${STAGING_REF}].user[bulk].W`)],
      INDEXED,
    );
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
// Decision-level spot checks for high-impact tools
// ────────────────────────────────────────────────────────────────────────

describe('risk-catalog.yaml — decision-level spot checks', () => {
  test('update_auth_config fires auth-config-write', () => {
    expect(
      risksFor('supabase__update_auth_config', { project_ref: STAGING_REF, config: {} }),
    ).toContain('supabase.auth-config-write');
  });

  test('create_function_secrets fires function-secret-write', () => {
    expect(
      risksFor('supabase__create_function_secrets', {
        project_ref: STAGING_REF,
        secrets: [{ name: 'STRIPE_KEY', value: 'sk_…' }],
      }),
    ).toContain('supabase.function-secret-write');
  });

  test('apply_migration with CREATE POLICY fires policy-write and migration-write', () => {
    const touched = risksFor('supabase__apply_migration', {
      project_ref: STAGING_REF,
      name: 'rls',
      query: 'CREATE POLICY p ON users FOR ALL USING (true);',
    });
    expect(touched).toContain('supabase.policy-write');
    expect(touched).toContain('supabase.migration-write');
  });

  test('execute_sql with mutating-looking SQL still only fires read risks', () => {
    const touched = risksFor('supabase__execute_sql', {
      project_ref: STAGING_REF,
      query: 'DELETE FROM users WHERE 1=1;',
    });
    expect(touched).toEqual(['supabase.read-data']);
  });

  test('delete_bucket fires bucket-write and the bulk object cascade', () => {
    const touched = risksFor('supabase__delete_bucket', {
      project_ref: STAGING_REF,
      id: 'avatars',
    });
    expect(touched).toContain('supabase.bucket-write');
    expect(touched).toContain('supabase.storage.bulk-object-write');
  });

  test('create_signed_url fires signed-url-read, object-read and read-data', () => {
    const touched = risksFor('supabase__create_signed_url', {
      project_ref: STAGING_REF,
      bucket: 'avatars',
      path: 'u/123.png',
    });
    expect(touched).toContain('supabase.storage.signed-url-read');
    expect(touched).toContain('supabase.storage.object-read');
    expect(touched).toContain('supabase.read-data');
  });

  test('parse → serialize → parse is stable for every pattern', () => {
    for (const e of CATALOG.risks) {
      for (const p of patternsOf(e)) {
        const a = parseSlice(p);
        const reparsed = parseSlice(serializeSlice(a));
        expect(reparsed.provider).toBe(a.provider);
        expect(reparsed.action).toBe(a.action);
        expect(reparsed.path.length).toBe(a.path.length);
      }
    }
  });
});
