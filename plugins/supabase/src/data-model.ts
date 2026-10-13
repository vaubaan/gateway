/**
 * Data model of the `supabase` provider — four planes under one project.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/supabase.md.
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
 * model is a faithful picture of the provider : a future tool drops into an
 * existing risk slot instead of opening a hole. `db-role` and `extension`
 * have no tool of their own ; `apply_migration` reaches them.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

export const supabaseDataModel: DataModel = {
  provider: 'supabase',
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
