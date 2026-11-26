/**
 * Data model of the `supabase` service — four planes under one project.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/supabase.md.
 *
 * A Supabase project (`project_ref`, the resource the owner labels with an
 * environment) federates four heterogeneous sub-systems : Postgres (`db`),
 * object storage (`storage`), GoTrue (`auth`) and Edge Functions
 * (`functions`). Each plane declares its entities with their containment
 * parent and the cardinalities a slice may name. Every `matches` pattern of
 * the catalog names entities declared here ; `validateDataModel` runs in
 * `definePlugin`.
 *
 * Some entities are declared *ahead of any tool* (`publication`,
 * `bucket-policy`, `mfa-factor`, `identity`, `functions-config`) so the
 * model is a faithful picture of the service : a future tool drops into an
 * existing risk slot instead of opening a hole. `db-role` and `extension`
 * have no tool of their own ; `apply_migration` reaches them.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const supabaseDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    // ─────────────────────────────────────────────────────────────────────
    // Plane `db` — Postgres, RLS policies and the migrations ledger.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'db',
      description:
        'Postgres database (schemas, tables, rows, indexes, functions, ' +
        'sequences, views), RLS policies and the migrations ledger.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description:
            'A Supabase project (project_ref). Root of every plane ; one project per ' +
            'environment — staging and prod are distinct projects.',
        },
        {
          name: 'schema',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'Postgres schema (`public`, `auth`, `storage`, custom).',
        },
        {
          name: 'table',
          parent: 'schema',
          cardinalities: ['bounded'],
          description: 'Postgres table inside a schema.',
        },
        {
          name: 'row',
          parent: 'table',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'A row inside a table. `bounded` for a single identified row or a small ' +
            'WHERE, `unbounded` for bulk writes. The cardinality marker tells ' +
            '`row-write-one` from `bulk-row-write`.',
        },
        {
          name: 'index',
          parent: 'table',
          cardinalities: ['bounded'],
          description: 'Postgres index on a table.',
        },
        {
          name: 'db-function',
          parent: 'schema',
          cardinalities: ['bounded'],
          description:
            'Postgres function or stored procedure inside a schema. Not the ' +
            '`edge-function` of the `functions` plane.',
        },
        {
          name: 'sequence',
          parent: 'schema',
          cardinalities: ['bounded'],
          description: 'Postgres sequence inside a schema.',
        },
        {
          name: 'view',
          parent: 'schema',
          cardinalities: ['bounded'],
          description: 'Postgres view inside a schema.',
        },
        {
          name: 'policy',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'Row-Level Security policy. Attached to a table in Postgres, tracked ' +
            'project-wide here as a critical posture surface.',
        },
        {
          name: 'db-role',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'Postgres role (`anon`, `authenticated`, custom) and its privileges. ' +
            'Reached through `apply_migration` (GRANT, REVOKE, CREATE ROLE).',
        },
        {
          name: 'publication',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'Logical replication publication. No tool today.',
        },
        {
          name: 'extension',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'Postgres extension (`vector`, `pg_net`, …). Enabling one shifts the ' +
            'posture (some open egress). Reached through `apply_migration`.',
        },
        {
          name: 'migration',
          parent: 'project',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'An applied migration in the supabase_migrations ledger (append-only, ' +
            'version timestamp).',
        },
        {
          name: 'branch',
          parent: 'project',
          cardinalities: ['one', 'unbounded'],
          description:
            'A preview branch, as its project sees it : listed under the parent, read, ' +
            'deleted or reset under the branch itself, which is a project of its own ' +
            '(its own ref, labelled `preview`). The acts are the virtual leaves ' +
            '`delete` and `reset`.',
        },
        {
          name: 'project-settings',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide settings singleton (metadata, API keys, advisors).',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `storage` — S3-like object storage, buckets with optional ACL.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'storage',
      description: 'S3-like object storage organised in buckets with an optional public ACL.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'bucket',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A storage bucket (`avatars`, `uploads`, …).',
        },
        {
          name: 'object',
          parent: 'bucket',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'An object (file) at a path inside a bucket. `bounded` for one concrete ' +
            'path, `unbounded` for bulk operations.',
        },
        {
          name: 'signed-url',
          parent: 'object',
          cardinalities: ['unbounded'],
          description:
            'A signed URL issued for an object. Distinct from a plain object read : ' +
            'the recipient is chosen by the agent (catalog `storage.signed-url-read`).',
        },
        {
          name: 'bucket-policy',
          parent: 'bucket',
          cardinalities: ['bounded'],
          description: 'Per-bucket storage RLS policy. No tool today.',
        },
        {
          name: 'storage-config',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide storage configuration singleton (quotas, CDN, transforms).',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `auth` — GoTrue : users, SSO, third-party JWT issuers.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'auth',
      description:
        'GoTrue authentication : users, SAML SSO, third-party JWT providers, auth configuration.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'user',
          parent: 'project',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'A GoTrue user identity. `bounded` for a single id or email, `unbounded` ' +
            'for listings and bulk writes.',
        },
        {
          name: 'link',
          parent: 'user',
          cardinalities: ['unbounded'],
          description:
            'A one-time auth link (magiclink, recovery, invite, signup). Ephemeral, ' +
            'but whoever holds the URL enters the user account.',
        },
        {
          name: 'credential',
          parent: 'user',
          cardinalities: ['one'],
          description:
            'What signs in as a user or grants them roles: password, email, phone, app_metadata. ' +
            'Written by create_user / update_user beside the user itself.',
        },
        {
          name: 'mfa-factor',
          parent: 'user',
          cardinalities: ['bounded'],
          description: 'MFA factor enrolled on a user. No tool today.',
        },
        {
          name: 'identity',
          parent: 'user',
          cardinalities: ['bounded'],
          description:
            'A linked external OAuth identity on a user (Google, Apple, GitHub, …). No tool today.',
        },
        {
          name: 'sso-provider',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A SAML SSO identity provider registered on the project.',
        },
        {
          name: 'third-party-auth',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A third-party JWT issuer (Firebase, Auth0, Cognito, generic OIDC).',
        },
        {
          name: 'auth-config',
          parent: 'project',
          cardinalities: ['one'],
          description:
            'Project-wide GoTrue configuration singleton (site URL, redirect allow-list, ' +
            'JWT expiry, OAuth toggles, password policy, mailer).',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `functions` — Edge Functions (Deno) and project-wide secrets.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'functions',
      description: 'Edge Functions (Deno runtime) and the project-wide function secrets.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'edge-function',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A deployed edge function, identified by its slug.',
        },
        {
          name: 'function-body',
          parent: 'edge-function',
          cardinalities: ['one'],
          description:
            'The current source of the function. May contain inline secrets (an ' +
            'anti-pattern, but frequent).',
        },
        {
          name: 'function-deployment',
          parent: 'edge-function',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'A deployed version of an edge function. Deploying switches the runtime ' +
            'with immediate effect on public traffic.',
        },
        {
          name: 'function-secret',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'A project-wide secret exposed to every edge function. Supabase does not ' +
            'scope secrets per function, hence the containment under `project`.',
        },
        {
          name: 'functions-config',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide functions configuration singleton. No tool today.',
        },
      ],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Schemas Supabase manages inside the project database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a service-managed schema is to a reader of free-form SQL :
 *
 *   - `sensitive`  it holds what Supabase keeps for itself — identities,
 *                  sessions, secrets, storage internals, queued requests. A
 *                  query that names it touches `supabase.read-managed-schemas`.
 *   - `inspection` it describes the database (catalogs, installed extension
 *                  objects, the GraphQL surface). Reading it is schema
 *                  inspection, an ordinary read.
 *
 * In both cases a table-level statement of a migration that targets the
 * schema is not an application write (`migration-sql.ts`).
 */
export type ManagedSchemaKind = 'sensitive' | 'inspection';

export interface ManagedSchema {
  readonly name: string;
  readonly kind: ManagedSchemaKind;
  readonly holds: string;
}

/**
 * The schemas Supabase creates and owns in every project database — the one
 * list both SQL readers use. A schema absent from it is the application's.
 */
export const SUPABASE_MANAGED_SCHEMAS: readonly ManagedSchema[] = [
  {
    name: 'auth',
    kind: 'sensitive',
    holds: 'GoTrue : users, identities, sessions, refresh tokens, MFA factors.',
  },
  { name: 'vault', kind: 'sensitive', holds: 'Supabase Vault : secrets and their decrypted view.' },
  {
    name: 'storage',
    kind: 'sensitive',
    holds: 'Storage internals : buckets, object rows, uploads.',
  },
  { name: 'pgsodium', kind: 'sensitive', holds: 'Encryption keys of pgsodium.' },
  { name: 'pgsodium_masks', kind: 'sensitive', holds: 'Decrypted views of pgsodium.' },
  {
    name: 'net',
    kind: 'sensitive',
    holds: 'pg_net : queued HTTP requests and responses, headers.',
  },
  { name: 'cron', kind: 'sensitive', holds: 'pg_cron : scheduled commands and their runs.' },
  { name: 'realtime', kind: 'sensitive', holds: 'Realtime : messages and subscriptions.' },
  {
    name: 'pgbouncer',
    kind: 'sensitive',
    holds: 'Pooler authentication lookup (password hashes).',
  },
  { name: 'extensions', kind: 'inspection', holds: 'Objects of the installed extensions.' },
  { name: 'graphql', kind: 'inspection', holds: 'pg_graphql internals.' },
  { name: 'graphql_public', kind: 'inspection', holds: 'The GraphQL entry point.' },
  { name: 'information_schema', kind: 'inspection', holds: 'The SQL-standard catalog views.' },
  { name: 'pg_catalog', kind: 'inspection', holds: 'The PostgreSQL system catalogs.' },
];

/**
 * Name prefixes Supabase and PostgreSQL reserve : `pg_` (system schemas),
 * `supabase_` (`supabase_migrations`, `supabase_functions`) and `_`
 * (`_realtime`, `_analytics`, `_supavisor`). A schema carrying one is managed.
 */
export const SUPABASE_MANAGED_SCHEMA_PREFIXES: readonly string[] = ['pg_', 'supabase_', '_'];

/**
 * The reserved prefixes whose schemas are sensitive to read. `pg_` is
 * narrowed to the two families of system schemas that hold data
 * (`pg_toast…` : the out-of-line values of every table ; `pg_temp…` : other
 * sessions' temporary tables) : PostgreSQL has no other `pg_` schema than
 * these and `pg_catalog`, while a query commonly qualifies a column with a
 * catalog name (`pg_class.relname`).
 */
export const SUPABASE_SENSITIVE_SCHEMA_PREFIXES: readonly string[] = [
  'pg_toast',
  'pg_temp',
  'supabase_',
  '_',
];

/**
 * Relations of the inspection schemas that hold more than a description of
 * the database : password hashes, foreign-server credentials, the text of
 * other sessions' queries, samples of column values, large objects, server
 * files and settings. They resolve without a schema qualifier, so a SQL
 * reader looks for the bare name.
 */
export const SUPABASE_SENSITIVE_CATALOG_RELATIONS: readonly string[] = [
  'pg_authid',
  'pg_shadow',
  'pg_user_mapping',
  'pg_user_mappings',
  'pg_largeobject',
  'pg_statistic',
  'pg_statistic_ext_data',
  'pg_stats',
  'pg_stats_ext',
  'pg_stats_ext_exprs',
  'pg_stat_activity',
  'pg_stat_statements',
  'pg_stat_replication',
  'pg_stat_subscription',
  'pg_subscription',
  'pg_replication_slots',
  'pg_file_settings',
  'pg_hba_file_rules',
  'pg_ident_file_mappings',
  'pg_settings',
  'pg_prepared_statements',
  'pg_cursors',
];

const MANAGED_BY_NAME: ReadonlyMap<string, ManagedSchema> = new Map(
  SUPABASE_MANAGED_SCHEMAS.map((schema) => [schema.name, schema]),
);

/** Is `schema` one Supabase or PostgreSQL manages (listed, or carrying a reserved prefix) ? */
export function isManagedSchema(schema: string): boolean {
  return (
    MANAGED_BY_NAME.has(schema) ||
    SUPABASE_MANAGED_SCHEMA_PREFIXES.some((prefix) => schema.startsWith(prefix))
  );
}

/** Is `schema` a managed schema whose content is more than a description of the database ? */
export function isSensitiveSchema(schema: string): boolean {
  const listed = MANAGED_BY_NAME.get(schema);
  if (listed !== undefined) return listed.kind === 'sensitive';
  return SUPABASE_SENSITIVE_SCHEMA_PREFIXES.some((prefix) => schema.startsWith(prefix));
}
