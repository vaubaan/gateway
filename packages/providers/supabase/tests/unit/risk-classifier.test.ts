/**
 * Tests for the v4 Supabase risk classifier.
 *
 * Coverage : ~25 tests, 4 planes × ~6 tools. Verifies :
 *   - Slice path shape (entity chain matches the data-model).
 *   - Cardinality marker emission (`row[one]` vs `row[bulk]`, `user[one]`
 *     vs `user[bulk]`, `object[one]` vs `object[bulk]`).
 *   - `execute_sql` is strictly R-only (spec §7.2 #2).
 *   - `apply_migration` multi-slice when DML / RLS keywords are present
 *     (research §6.2 option 2).
 *   - Strict-fail for unknown tools / unresolved project_ref.
 */

import { describe, expect, test } from 'vitest';

import { serializeSlice } from '@vaubaan/policy-engine';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifySupabaseV4 } from '../../src/risk-classifier.ts';

// ── fixtures ────────────────────────────────────────────────────────────

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';
const PROD_REF = 'prodxxxxxxxxxxxxxxxx';

function mkBinding(ref: string, environment: string): ProviderBinding {
  return {
    id: `bind-${ref}`,
    project_id: 'project-1',
    provider: 'supabase',
    resource_ref: ref,
    display_name: null,
    environment,
    created_at: '2026-01-01T00:00:00Z',
  };
}

const stagingBinding = mkBinding(STAGING_REF, 'staging');
const prodBinding = mkBinding(PROD_REF, 'prod');

/** Helper : run the classifier and return the serialized slice strings. */
function classifySerialized(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding> = [stagingBinding],
): string[] | string {
  const r = classifySupabaseV4(tool, args, bindings);
  if ('denied' in r) return r.denied;
  return r.slices.map(serializeSlice);
}

// ────────────────────────────────────────────────────────────────────────
// Plane `db`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabaseV4 — plane db', () => {
  test('get_project → project-settings.R', () => {
    expect(classifySerialized('supabase__get_project', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].project-settings.R`,
    ]);
  });

  test('list_tables → schema[any].table[any].R', () => {
    expect(classifySerialized('supabase__list_tables', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].R`,
    ]);
  });

  test('list_migrations → migration[any].R', () => {
    expect(classifySerialized('supabase__list_migrations', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].migration[any].R`,
    ]);
  });

  test('execute_sql is strictly R-only (spec §7.2 #2)', () => {
    // even with a query that looks mutating, the classifier emits R
    expect(
      classifySerialized('supabase__execute_sql', {
        project_ref: STAGING_REF,
        query: "INSERT INTO users(name) VALUES ('a');",
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].row[bulk].R`]);

    // pure SELECT also produces the same R slice
    expect(
      classifySerialized('supabase__execute_sql', {
        project_ref: STAGING_REF,
        query: 'SELECT * FROM users;',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].row[bulk].R`]);
  });

  test('apply_migration with pure DDL → schema/table.W only', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'add_email',
        query: 'ALTER TABLE users ADD COLUMN email text;',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].table[any].W`]);
  });

  test('apply_migration with embedded DML → emits row[bulk].W too', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'backfill_email',
        query:
          "ALTER TABLE users ADD COLUMN email text; UPDATE users SET email = '' WHERE email IS NULL;",
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].W`,
      `supabase.project[${STAGING_REF}].schema[any].table[any].row[bulk].W`,
    ]);
  });

  test('apply_migration with CREATE POLICY → emits policy[any].W too', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'enforce_rls',
        query:
          'CREATE POLICY tenant_isolation ON users FOR SELECT USING (org_id = current_user_org_id());',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].W`,
      `supabase.project[${STAGING_REF}].policy[any].W`,
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `storage`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabaseV4 — plane storage', () => {
  test('list_buckets → bucket[any].R', () => {
    expect(classifySerialized('supabase__list_buckets', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].bucket[any].R`,
    ]);
  });

  test('create_bucket emits bucket[<id>].W', () => {
    expect(
      classifySerialized('supabase__create_bucket', {
        project_ref: STAGING_REF,
        id: 'avatars',
        name: 'Avatars',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].bucket[avatars].W`]);
  });

  test('delete_bucket emits bucket.W + cascade object[bulk].W', () => {
    expect(
      classifySerialized('supabase__delete_bucket', {
        project_ref: STAGING_REF,
        id: 'uploads',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].bucket[uploads].W`,
      `supabase.project[${STAGING_REF}].bucket[uploads].object[bulk].W`,
    ]);
  });

  test('upload_object emits a path slice AND the object[one] cardinality marker', () => {
    expect(
      classifySerialized('supabase__upload_object', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'u/123.png',
        content_base64: 'AAAA',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].bucket[avatars].object[u/123.png].W`,
      `supabase.project[${STAGING_REF}].bucket[avatars].object[one].W`,
    ]);
  });

  test('create_signed_url emits object[<path>].signed-url[any].R', () => {
    expect(
      classifySerialized('supabase__create_signed_url', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'u/123.png',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].bucket[avatars].object[u/123.png].signed-url[any].R`,
    ]);
  });

  test('update_storage_config → storage-config.W', () => {
    expect(
      classifySerialized('supabase__update_storage_config', { project_ref: STAGING_REF }),
    ).toEqual([`supabase.project[${STAGING_REF}].storage-config.W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `auth`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabaseV4 — plane auth', () => {
  test('list_users → user[any].R', () => {
    expect(classifySerialized('supabase__list_users', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].user[any].R`,
    ]);
  });

  test('create_user emits user[<email>].W + user[one].W cardinality marker', () => {
    expect(
      classifySerialized('supabase__create_user', {
        project_ref: STAGING_REF,
        email: 'alice@example.com',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].user[alice@example.com].W`,
      `supabase.project[${STAGING_REF}].user[one].W`,
    ]);
  });

  test('delete_user emits user[<id>].W + user[one].W (single-user op)', () => {
    expect(
      classifySerialized('supabase__delete_user', {
        project_ref: STAGING_REF,
        user_id: 'uuid-1',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].user[uuid-1].W`,
      `supabase.project[${STAGING_REF}].user[one].W`,
    ]);
  });

  test('generate_link → user[<target>].link[<type>].W', () => {
    expect(
      classifySerialized('supabase__generate_link', {
        project_ref: STAGING_REF,
        email: 'bob@example.com',
        type: 'magiclink',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].user[bob@example.com].link[magiclink].W`]);
  });

  test('update_auth_config → auth-config.W', () => {
    expect(
      classifySerialized('supabase__update_auth_config', {
        project_ref: STAGING_REF,
        config: { site_url: 'https://app.example.com' },
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].auth-config.W`]);
  });

  test('create_sso_provider → sso-provider[<type>].W', () => {
    expect(
      classifySerialized('supabase__create_sso_provider', {
        project_ref: STAGING_REF,
        type: 'saml',
        metadata_url: 'https://idp.example.com/saml',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].sso-provider[saml].W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `functions`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabaseV4 — plane functions', () => {
  test('list_functions → edge-function[any].R', () => {
    expect(classifySerialized('supabase__list_functions', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[any].R`,
    ]);
  });

  test('get_function_body → function-body.R + edge-function[*].R', () => {
    expect(
      classifySerialized('supabase__get_function_body', {
        project_ref: STAGING_REF,
        function_slug: 'webhook',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-body.R`,
      `supabase.project[${STAGING_REF}].edge-function[webhook].R`,
    ]);
  });

  test('create_function → edge-function[<slug>].W', () => {
    expect(
      classifySerialized('supabase__create_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        body: 'export default () => new Response("ok")',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].edge-function[webhook].W`]);
  });

  test('deploy_function with files → function-deployment.W + edge-function.W', () => {
    expect(
      classifySerialized('supabase__deploy_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        entrypoint_path: 'index.ts',
        files: [{ name: 'index.ts', content: 'export default () => 1' }],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-deployment[any].W`,
      `supabase.project[${STAGING_REF}].edge-function[webhook].W`,
    ]);
  });

  test('deploy_function with no files → function-deployment.W only', () => {
    expect(
      classifySerialized('supabase__deploy_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        entrypoint_path: 'index.ts',
        files: [],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-deployment[any].W`,
    ]);
  });

  test('create_function_secrets → function-secret[<name>].W per secret', () => {
    expect(
      classifySerialized('supabase__create_function_secrets', {
        project_ref: STAGING_REF,
        secrets: [
          { name: 'STRIPE_KEY', value: 'sk_…' },
          { name: 'OPENAI_KEY', value: 'sk-…' },
        ],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].function-secret[STRIPE_KEY].W`,
      `supabase.project[${STAGING_REF}].function-secret[OPENAI_KEY].W`,
    ]);
  });

  test('delete_function_secrets → function-secret[<name>].W per name', () => {
    expect(
      classifySerialized('supabase__delete_function_secrets', {
        project_ref: STAGING_REF,
        names: ['OBSOLETE_KEY'],
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].function-secret[OBSOLETE_KEY].W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Strict-fail behavior
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabaseV4 — strict-fail', () => {
  test('unknown tool → denied', () => {
    const r = classifySupabaseV4('supabase__nope_not_a_tool', { project_ref: STAGING_REF }, [
      stagingBinding,
    ]);
    expect(r).toEqual({ denied: "unknown supabase tool 'supabase__nope_not_a_tool'." });
  });

  test('unbound project_ref → denied', () => {
    const r = classifySupabaseV4('supabase__get_project', { project_ref: 'rogue-ref' }, [
      stagingBinding,
    ]);
    expect(r).toEqual({
      denied: "supabase project 'rogue-ref' is not bound to this access token.",
    });
  });

  test('ambiguous binding without explicit project_ref → denied', () => {
    const r = classifySupabaseV4('supabase__get_project', {}, [stagingBinding, prodBinding]);
    expect(r).toEqual({ denied: 'ambiguous supabase target: specify project_ref.' });
  });

  test('single binding without project_ref → resolves from binding', () => {
    expect(classifySerialized('supabase__get_project', {}, [stagingBinding])).toEqual([
      `supabase.project[${STAGING_REF}].project-settings.R`,
    ]);
  });
});
