/**
 * The whole decision, not the classifier alone : real catalog, real
 * classifier, and the engine's `evaluateCall` with the resolver the gateway
 * builds (`envResolverFor(mission resources, plugin.envOf)` — the exact
 * composition of `evaluateCallForToken` in `@vaubaan/gateway-core`).
 *
 * Pins what the per-slice tests cannot see :
 *   - an env-scoped risk touched on a project the owner did not label, or
 *     labelled outside `acceptable_in_envs`, refuses the call whatever the
 *     mission accepted (listing users on an unlabelled project, bulk row
 *     writes of a migration on prod) ;
 *   - what a mission written from macro-actions at trust levels allows and
 *     refuses, call by call, on a correctly labelled project — none needs the
 *     fallback to do what its macro-actions say.
 */
import { describe, expect, test } from 'vitest';

import type { ProviderPlugin, Resource, RiskId } from '@vaubaan/plugin-sdk';
import { policyFromMacroActions } from '@vaubaan/plugin-sdk/testing';
import { envResolverFor, evaluateCall } from '@vaubaan/policy-engine';

import { supabaseCatalog, supabasePlugin } from '../../src/index.ts';

const { catalog, indexed } = supabaseCatalog;
/** Through the contract type : `envOf` is optional and Supabase does not implement it. */
const plugin: ProviderPlugin = supabasePlugin;

const STAGING = 'stagingprojectrefxxx';
const PROD = 'prodprojectrefxxxxxx';
const PREVIEW = 'previewprojectrefxxx';
const UNLABELLED = 'unlabelledprojectref';

const project = (ref: string, env?: string): Resource => ({
  provider: 'supabase',
  ref,
  displayName: ref,
  ...(env === undefined ? {} : { env }),
});

const mission: readonly Resource[] = [
  project(STAGING, 'staging'),
  project(PROD, 'prod'),
  project(PREVIEW, 'preview'),
  project(UNLABELLED),
];

const FALLBACK = catalog.risks.find((r) => r.fallback)!.id;
const ENVS = ['preview', 'staging', 'prod'] as const;
const qualify = (id: RiskId, env: string): RiskId => id.replace('supabase.', `supabase[${env}].`);

/**
 * Every id a mission could conceivably hold, and some it could not : the
 * whole catalog (fallback included), bare and qualified with each
 * environment — including the forged `supabase[prod].bulk-row-write`.
 */
const EVERYTHING: readonly RiskId[] = catalog.risks.flatMap((r) => [
  r.id,
  ...ENVS.map((env) => qualify(r.id, env)),
]);

function decide(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  accepted: readonly RiskId[],
) {
  const outcome = plugin.classify(tool, args, mission);
  if ('denied' in outcome) throw new Error(`${tool} denied by the classifier: ${outcome.denied}`);
  return evaluateCall({
    executed_slices: outcome.slices,
    token_accepted_risks: new Set(accepted),
    catalog: indexed,
    envResolver: envResolverFor(mission, plugin.envOf?.bind(plugin)),
  });
}

/** The missions the decisions below are made for, written as the creation form writes them. */
const MISSIONS = {
  /** Reads, no environment : nothing env-scoped. */
  'read-only-analyst': policyFromMacroActions(plugin, { query: 'careful' }),
  /** Everything but administration, on staging only. */
  'staging-developer': policyFromMacroActions(
    plugin,
    {
      query: 'autonomous',
      'change-data': 'autonomous',
      'change-schema': 'autonomous',
      'ship-functions': 'autonomous',
    },
    { envs: ['staging'] },
  ),
  /**
   * Schema changes on staging and prod, plus the backfills and grants a
   * migration needs ticked by hand on staging alone. The engine refuses a bulk
   * row write on prod whatever the mission holds (`acceptable_in_envs`).
   */
  'migration-operator': [
    ...policyFromMacroActions(plugin, { query: 'careful' }),
    ...policyFromMacroActions(
      plugin,
      { 'change-schema': 'trusting' },
      { envs: ['staging', 'prod'] },
    ),
    ...(['supabase[staging].bulk-row-write', 'supabase[staging].db-role-write'] as const).map(
      (risk_id) => ({
        risk_id,
        quota: 50,
        rate_limit: { max: 10, window_seconds: 60 },
        gate: 'approval' as const,
      }),
    ),
  ],
} as const;
type MissionName = keyof typeof MISSIONS;
const missionRisks = (id: MissionName): readonly RiskId[] => MISSIONS[id].map((e) => e.risk_id);

// ─── SQL samples ─────────────────────────────────────────────────────────────

const DDL = 'create table public.todo (id bigint primary key, title text);';
const RLS =
  'alter table public.todo enable row level security; create policy p on public.todo using (true);';
const BACKFILL =
  'alter table public.todo add column done boolean; update public.todo set done = false;';
const DROP_TABLE = 'drop table public.todo;';
const GRANT = 'grant select on public.todo to anon;';
const EXTENSION = 'create extension if not exists vector;';
const FUNCTION = 'create function public.f() returns int language sql as $$ select 1 $$;';
const DYNAMIC = "do $$ begin execute 'del' || 'ete from auth.users'; end $$;";

const migration = (ref: string, query: string) =>
  ['supabase__apply_migration', { project_ref: ref, name: 'm', query }] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Unlabelled project — env-scoped operations are refused
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase — a project without an environment label', () => {
  test('listing users is refused with read-data alone', () => {
    const decision = decide('supabase__list_users', { project_ref: UNLABELLED }, [
      'supabase.read-data',
    ]);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.missing_risks).toEqual(['supabase.auth.read-users']);
    expect(decision.covered_risks).toEqual(['supabase.read-data']);
    expect(decision.hint).toContain('a resource with no environment label');
  });

  test('listing users is refused whatever the mission holds', () => {
    for (const [tool, args] of [
      ['supabase__list_users', { project_ref: UNLABELLED }],
      ['supabase__get_user', { project_ref: UNLABELLED, user_id: 'u1' }],
    ] as const) {
      const decision = decide(tool, args, EVERYTHING);
      expect(decision.outcome, tool).toBe('denied');
      if (decision.outcome !== 'denied') continue;
      expect(decision.missing_risks).toEqual(['supabase.auth.read-users']);
    }
  });

  test('the same listing is allowed once the project is labelled and the risk accepted there', () => {
    expect(
      decide('supabase__list_users', { project_ref: STAGING }, [
        'supabase.read-data',
        'supabase[staging].auth.read-users',
      ]),
    ).toEqual({
      outcome: 'allowed',
      risks_touched: ['supabase.read-data', 'supabase[staging].auth.read-users'],
    });
  });

  test.each<[string, Record<string, unknown>]>([
    ['supabase__apply_migration', { name: 'm', query: DDL }],
    ['supabase__upload_object', { bucket: 'b', path: 'p.txt', content_base64: 'AA' }],
    ['supabase__create_bucket', { id: 'b', name: 'B' }],
    ['supabase__delete_bucket', { id: 'b' }],
    ['supabase__create_user', { email: 'a@b.c' }],
    ['supabase__generate_link', { email: 'a@b.c', type: 'magiclink' }],
    ['supabase__update_auth_config', { config: {} }],
    ['supabase__update_storage_config', { config: {} }],
    ['supabase__create_sso_provider', { type: 'saml' }],
    ['supabase__deploy_function', { slug: 'fn', entrypoint_path: 'index.ts', files: [] }],
    ['supabase__create_function_secrets', { secrets: [{ name: 'K', value: 'v' }] }],
  ])('every write is refused, whatever the mission holds : %s', (tool, args) => {
    const decision = decide(tool, { ...args, project_ref: UNLABELLED }, EVERYTHING);
    expect(decision.outcome).toBe('denied');
  });

  test.each<[string, Record<string, unknown>]>([
    ['supabase__get_project', {}],
    ['supabase__list_tables', {}],
    ['supabase__execute_sql', { query: 'select 1' }],
    ['supabase__list_buckets', {}],
    ['supabase__get_auth_config', {}],
  ])('account-scoped reads stay allowed with read-data : %s', (tool, args) => {
    expect(decide(tool, { ...args, project_ref: UNLABELLED }, ['supabase.read-data'])).toEqual({
      outcome: 'allowed',
      risks_touched: ['supabase.read-data'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prod — bulk row writes are not acceptable at all
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase — bulk row writes on a prod project', () => {
  test('a migration embedding DML is refused with migration-write alone', () => {
    const decision = decide(...migration(PROD, BACKFILL), ['supabase[prod].migration-write']);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.missing_risks).toEqual(['supabase[prod].bulk-row-write']);
    expect(decision.covered_risks).toEqual(['supabase[prod].migration-write']);
    expect(decision.hint).toContain("a resource labelled 'prod'");
    expect(decision.hint).toContain('[preview, staging]');
  });

  test.each<[string, string]>([
    ['embedded DML', BACKFILL],
    ['a dropped table', DROP_TABLE],
    ['a function body the classifier cannot read', FUNCTION],
    ['dynamic SQL', DYNAMIC],
  ])('refused whatever the mission holds, a forged prod id included : %s', (_label, query) => {
    expect(EVERYTHING).toContain('supabase[prod].bulk-row-write');
    const decision = decide(...migration(PROD, query), EVERYTHING);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.missing_risks).toContain('supabase[prod].bulk-row-write');
  });

  test('a bucket delete (bulk object cascade) is refused on prod whatever the mission holds', () => {
    const decision = decide('supabase__delete_bucket', { project_ref: PROD, id: 'b' }, EVERYTHING);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.missing_risks).toEqual(['supabase[prod].storage.bulk-object-write']);
  });

  test('a plain DDL migration on prod needs migration-write only', () => {
    expect(decide(...migration(PROD, DDL), ['supabase[prod].migration-write'])).toEqual({
      outcome: 'allowed',
      risks_touched: ['supabase[prod].migration-write'],
    });
  });

  test.each(['staging', 'preview'] as const)(
    'the same DML migration is allowed on a %s project that accepted both risks',
    (env) => {
      const ref = env === 'staging' ? STAGING : PREVIEW;
      expect(
        decide(...migration(ref, BACKFILL), [
          `supabase[${env}].migration-write`,
          `supabase[${env}].bulk-row-write`,
        ]).outcome,
      ).toBe('allowed');
    },
  );

  test('a migration the classifier cannot read needs every db write class', () => {
    const everyClass: RiskId[] = [
      'supabase[staging].migration-write',
      'supabase[staging].bulk-row-write',
      'supabase[staging].policy-write',
      'supabase[staging].db-role-write',
      'supabase[staging].extension-write',
    ];
    expect(decide(...migration(STAGING, DYNAMIC), everyClass)).toEqual({
      outcome: 'allowed',
      risks_touched: everyClass,
    });
    for (const withheld of everyClass) {
      const decision = decide(
        ...migration(STAGING, DYNAMIC),
        everyClass.filter((id) => id !== withheld),
      );
      expect(decision.outcome, `without ${withheld}`).toBe('denied');
      if (decision.outcome === 'denied') expect(decision.missing_risks).toEqual([withheld]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missions from macro-actions — what each allows and refuses on labelled projects
// ─────────────────────────────────────────────────────────────────────────────

type Expected = 'allowed' | 'denied';
type Row = readonly [label: string, tool: string, args: Record<string, unknown>, Expected];

const on = (ref: string, args: Record<string, unknown> = {}) => ({ project_ref: ref, ...args });
const sql = (ref: string, query: string) => on(ref, { name: 'm', query });

function expectRows(name: MissionName, rows: readonly Row[]): void {
  const accepted = missionRisks(name);
  for (const [label, tool, args, expected] of rows) {
    const decision = decide(tool, args, accepted);
    expect(decision.outcome, `${name} — ${label}`).toBe(expected);
    if (decision.outcome === 'allowed') {
      expect(decision.risks_touched, `${name} — ${label}`).not.toContain(FALLBACK);
    }
  }
}

describe('supabase missions from macro-actions — decisions on labelled projects', () => {
  test('no mission carries the fallback or a risk outside its acceptable environments', () => {
    for (const entries of Object.values(MISSIONS)) {
      for (const entry of entries) {
        expect(entry.risk_id).not.toContain('uncategorized');
        const env = /\[([a-z-]+)\]/.exec(entry.risk_id)?.[1];
        const risk = catalog.risks.find((r) => qualify(r.id, env ?? '') === entry.risk_id);
        if (env) expect(risk?.acceptable_in_envs, entry.risk_id).toContain(env);
      }
    }
  });

  test('read-only-analyst : queries and listings on every project, no write, no user listing', () => {
    const rows: Row[] = [];
    for (const ref of [STAGING, PROD, PREVIEW, UNLABELLED]) {
      rows.push(
        ['get_project', 'supabase__get_project', on(ref), 'allowed'],
        ['list_tables', 'supabase__list_tables', on(ref), 'allowed'],
        ['list_migrations', 'supabase__list_migrations', on(ref), 'allowed'],
        ['execute_sql', 'supabase__execute_sql', on(ref, { query: 'select 1' }), 'allowed'],
        ['list_buckets', 'supabase__list_buckets', on(ref), 'allowed'],
        ['list_objects', 'supabase__list_objects', on(ref, { bucket: 'b' }), 'allowed'],
        ['list_users', 'supabase__list_users', on(ref), 'denied'],
        ['get_user', 'supabase__get_user', on(ref, { user_id: 'u1' }), 'denied'],
        // `query` holds signed URLs and function reads.
        [
          'signed url',
          'supabase__create_signed_url',
          on(ref, { bucket: 'b', path: 'p' }),
          'allowed',
        ],
        [
          'function body',
          'supabase__get_function_body',
          on(ref, { function_slug: 'fn' }),
          'allowed',
        ],
        ['migration', 'supabase__apply_migration', sql(ref, DDL), 'denied'],
        [
          'upload',
          'supabase__upload_object',
          on(ref, { bucket: 'b', path: 'p', content_base64: 'AA' }),
          'denied',
        ],
        ['create_user', 'supabase__create_user', on(ref, { email: 'a@b.c' }), 'denied'],
      );
    }
    expectRows('read-only-analyst', rows);
  });

  test('staging-developer : development writes on staging, reads everywhere, nothing written elsewhere', () => {
    const s = STAGING;
    const writes: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ['DDL migration', 'supabase__apply_migration', { name: 'm', query: DDL }],
      ['RLS migration', 'supabase__apply_migration', { name: 'm', query: RLS }],
      ['backfill migration', 'supabase__apply_migration', { name: 'm', query: BACKFILL }],
      ['drop table migration', 'supabase__apply_migration', { name: 'm', query: DROP_TABLE }],
      ['extension migration', 'supabase__apply_migration', { name: 'm', query: EXTENSION }],
      ['create_bucket', 'supabase__create_bucket', { id: 'b', name: 'B' }],
      ['update_bucket', 'supabase__update_bucket', { id: 'b' }],
      ['delete_bucket', 'supabase__delete_bucket', { id: 'b' }],
      [
        'upload_object',
        'supabase__upload_object',
        { bucket: 'b', path: 'dir/p.txt', content_base64: 'AA' },
      ],
      ['delete_object', 'supabase__delete_object', { bucket: 'b', path: 'dir/p.txt' }],
      ['create_user by email', 'supabase__create_user', { email: 'a@b.c' }],
      ['create_user by phone', 'supabase__create_user', { phone: '+33612345678' }],
      ['update_user', 'supabase__update_user', { user_id: 'u1' }],
      ['delete_user', 'supabase__delete_user', { user_id: 'u1' }],
      ['generate_link', 'supabase__generate_link', { email: 'a@b.c', type: 'magiclink' }],
      ['create_function', 'supabase__create_function', { slug: 'fn', body: 'x' }],
      ['update_function', 'supabase__update_function', { function_slug: 'fn' }],
      ['delete_function', 'supabase__delete_function', { function_slug: 'fn' }],
      [
        'deploy_function',
        'supabase__deploy_function',
        { slug: 'fn', entrypoint_path: 'i.ts', files: [{ name: 'i.ts', content: 'x' }] },
      ],
      [
        'create secrets',
        'supabase__create_function_secrets',
        { secrets: [{ name: 'K', value: 'v' }] },
      ],
      ['delete secrets', 'supabase__delete_function_secrets', { names: ['K'] }],
    ];
    const reads: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ['get_project', 'supabase__get_project', {}],
      ['execute_sql', 'supabase__execute_sql', { query: 'select 1' }],
      ['list_objects', 'supabase__list_objects', { bucket: 'b' }],
      ['list_functions', 'supabase__list_functions', {}],
      ['get_function_body', 'supabase__get_function_body', { function_slug: 'fn' }],
      ['get_auth_config', 'supabase__get_auth_config', {}],
    ];
    const rows: Row[] = [
      ...writes.map(([l, t, a]): Row => [`${l} on staging`, t, on(s, a), 'allowed']),
      ...writes.map(([l, t, a]): Row => [`${l} on prod`, t, on(PROD, a), 'denied']),
      ...writes.map(([l, t, a]): Row => [`${l} unlabelled`, t, on(UNLABELLED, a), 'denied']),
      ...[s, PROD, UNLABELLED].flatMap((ref) =>
        reads.map(([l, t, a]): Row => [`${l} on ${ref}`, t, on(ref, a), 'allowed']),
      ),
      ['list_users on staging', 'supabase__list_users', on(s), 'allowed'],
      ['get_user on staging', 'supabase__get_user', on(s, { user_id: 'u1' }), 'allowed'],
      ['list_users on prod', 'supabase__list_users', on(PROD), 'denied'],
      ['list_users unlabelled', 'supabase__list_users', on(UNLABELLED), 'denied'],
      // Database roles and project-level configuration are `administer`, not ticked.
      ['grant migration on staging', 'supabase__apply_migration', sql(s, GRANT), 'denied'],
      // A new function may carry grants : it needs db-role-write too.
      ['function migration on staging', 'supabase__apply_migration', sql(s, FUNCTION), 'denied'],
      ['auth config on staging', 'supabase__update_auth_config', on(s, { config: {} }), 'denied'],
      [
        'storage config on staging',
        'supabase__update_storage_config',
        on(s, { config: {} }),
        'denied',
      ],
      ['sso on staging', 'supabase__create_sso_provider', on(s, { type: 'saml' }), 'denied'],
      [
        'third-party auth on staging',
        'supabase__create_third_party_auth',
        on(s, { type: 'oidc' }),
        'denied',
      ],
    ];
    expectRows('staging-developer', rows);
  });

  test('migration-operator : any migration on staging ; on prod, plain DDL, RLS and extensions only', () => {
    const rows: Row[] = [
      ...[DDL, RLS, BACKFILL, DROP_TABLE, GRANT, EXTENSION, FUNCTION, DYNAMIC].map((query): Row => [
        `staging: ${query}`,
        'supabase__apply_migration',
        sql(STAGING, query),
        'allowed',
      ]),
      ['prod: DDL', 'supabase__apply_migration', sql(PROD, DDL), 'allowed'],
      ['prod: RLS', 'supabase__apply_migration', sql(PROD, RLS), 'allowed'],
      ['prod: extension', 'supabase__apply_migration', sql(PROD, EXTENSION), 'allowed'],
      ...[BACKFILL, DROP_TABLE, GRANT, FUNCTION, DYNAMIC].map((query): Row => [
        `prod: ${query}`,
        'supabase__apply_migration',
        sql(PROD, query),
        'denied',
      ]),
      ['unlabelled: DDL', 'supabase__apply_migration', sql(UNLABELLED, DDL), 'denied'],
      ['preview: DDL', 'supabase__apply_migration', sql(PREVIEW, DDL), 'denied'],
      ...[STAGING, PROD, UNLABELLED].flatMap((ref): Row[] => [
        [`list_migrations on ${ref}`, 'supabase__list_migrations', on(ref), 'allowed'],
        [`list_tables on ${ref}`, 'supabase__list_tables', on(ref), 'allowed'],
        [
          `execute_sql on ${ref}`,
          'supabase__execute_sql',
          on(ref, { query: 'select 1' }),
          'allowed',
        ],
      ]),
      [
        'upload on staging',
        'supabase__upload_object',
        on(STAGING, { bucket: 'b', path: 'p', content_base64: 'AA' }),
        'denied',
      ],
      [
        'create_user on staging',
        'supabase__create_user',
        on(STAGING, { email: 'a@b.c' }),
        'denied',
      ],
      ['list_users on staging', 'supabase__list_users', on(STAGING), 'denied'],
    ];
    expectRows('migration-operator', rows);
  });

  test('change-schema at Trusting gates what it allows on prod behind an approval', () => {
    const lines = MISSIONS['migration-operator'];
    for (const query of [DDL, RLS]) {
      const decision = decide(...migration(PROD, query), missionRisks('migration-operator'));
      expect(decision.outcome).toBe('allowed');
      if (decision.outcome !== 'allowed') continue;
      for (const id of decision.risks_touched) {
        expect(lines.find((e) => e.risk_id === id)?.gate, id).toBe('approval');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute_sql on the schemas Supabase manages — a read risk of its own
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase — SQL reads of the managed schemas', () => {
  const sql = (ref: string, query: string) =>
    ['supabase__execute_sql', { project_ref: ref, query }] as const;
  const AUTH_USERS = 'select email, encrypted_password from auth.users';
  const VAULT = 'select * from vault.decrypted_secrets';
  const UNKNOWN_FUNCTION = 'select public.export_everything()';
  const APPLICATION = 'select id, title from public.todo';

  test('the read-only analyst reads application tables, never auth, vault or an unread query', () => {
    const analyst = missionRisks('read-only-analyst');
    for (const ref of [STAGING, PROD, PREVIEW, UNLABELLED]) {
      expect(decide(...sql(ref, APPLICATION), analyst).outcome, ref).toBe('allowed');
    }
    for (const query of [AUTH_USERS, VAULT, UNKNOWN_FUNCTION]) {
      const decision = decide(...sql(STAGING, query), analyst);
      expect(decision.outcome, query).toBe('denied');
      if (decision.outcome !== 'denied') continue;
      expect(decision.missing_risks, query).toEqual(['supabase[staging].read-managed-schemas']);
      expect(decision.covered_risks, query).toEqual(['supabase.read-data']);
    }
  });

  test('read-data alone never covers it, on any project', () => {
    for (const ref of [STAGING, PROD, PREVIEW, UNLABELLED]) {
      expect(decide(...sql(ref, AUTH_USERS), ['supabase.read-data']).outcome, ref).toBe('denied');
    }
  });

  test('accepted for an environment, it passes there and nowhere else', () => {
    const accepted: readonly RiskId[] = [
      'supabase.read-data',
      'supabase[staging].read-managed-schemas',
    ];
    expect(decide(...sql(STAGING, AUTH_USERS), accepted).outcome).toBe('allowed');
    expect(decide(...sql(PROD, AUTH_USERS), accepted).outcome).toBe('denied');
    expect(decide(...sql(PREVIEW, AUTH_USERS), accepted).outcome).toBe('denied');
  });

  test('on an unlabelled project it is refused whatever the mission holds', () => {
    for (const query of [AUTH_USERS, UNKNOWN_FUNCTION]) {
      const decision = decide(...sql(UNLABELLED, query), EVERYTHING);
      expect(decision.outcome, query).toBe('denied');
      if (decision.outcome !== 'denied') continue;
      expect(decision.hint).toContain('a resource with no environment label');
    }
  });

  test('query reaches them only in the environments of the mission ; without one, nobody does', () => {
    const developer = missionRisks('staging-developer');
    for (const query of [AUTH_USERS, UNKNOWN_FUNCTION]) {
      expect(decide(...sql(STAGING, query), developer).outcome, `staging ${query}`).toBe('allowed');
      expect(decide(...sql(PROD, query), developer).outcome, `prod ${query}`).toBe('denied');
    }
    expect(decide(...sql(PROD, APPLICATION), developer).outcome).toBe('allowed');
    const operator = missionRisks('migration-operator');
    expect(decide(...sql(STAGING, AUTH_USERS), operator).outcome).toBe('denied');
    expect(decide(...sql(PROD, AUTH_USERS), operator).outcome).toBe('denied');
    expect(decide(...sql(PROD, APPLICATION), operator).outcome).toBe('allowed');
  });
});
