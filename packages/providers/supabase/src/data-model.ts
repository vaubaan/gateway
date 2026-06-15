/**
 * Supabase data-model — the declarative graph of entities for the four
 * Supabase planes : `db`, `storage`, `auth`, `functions`.
 *
 * Source of truth : `.vaubaan/research/providers/supabase.md` §1.
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * Each plane lists its entities with their containment parent and the
 * cardinalities that make sense for the entity (at least one). The slice
 * patterns in `risk-catalog.yaml` reference these entity names — a lint
 * verifies every pattern only mentions declared entities.
 *
 * Some entities are declared *anticipatorily* (no tool ships against them
 * today) so that the data-model is a faithful picture of the Supabase
 * surface — that way a future tool (e.g. `create_extension`) drops into a
 * pre-existing risk slot rather than introducing a hole. Cf. research §7.2.
 */

import type { DataModel } from '@vaubaan/shared';

export const supabaseDataModel: DataModel = {
  provider: 'supabase',
  planes: [
    // ─────────────────────────────────────────────────────────────────────
    // Plane `db` — Postgres + RLS + migrations.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'db',
      description:
        'Postgres database (schemas, tables, rows, indexes, functions, ' +
        'sequences, views) + RLS policies + migrations ledger.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          description:
            'A Supabase project (project_ref). Root of every plane — one ' +
            'project_ref per env (staging vs prod are distinct projects).',
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
            'A row inside a table. Always selected as `bounded` (single id / ' +
            'small WHERE) or `unbounded` (bulk write — `[*]`). Cardinality ' +
            'distinguishes `row-write-one` from `bulk-row-write` risks.',
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
            'Postgres function / stored procedure inside a schema. NOT to be ' +
            'confused with the `edge-function` of the `functions` plane.',
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
            'Row-Level Security (RLS) policy. Conceptually attached to a ' +
            'table but tracked project-wide as a critical posture surface.',
        },
        {
          name: 'db-role',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'Postgres role (`anon`, `authenticated`, custom). No MCP tool ' +
            'today — anticipated (deny by default in catalog).',
        },
        {
          name: 'publication',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'Logical replication publication. Anticipated entity (no tool).',
        },
        {
          name: 'extension',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'Postgres extension (`vector`, `pg_net`, ...). Posture-shift if ' +
            'enabled (some extensions open egress). No tool today.',
        },
        {
          name: 'migration',
          parent: 'project',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'Applied migration entry in the supabase_migrations ledger ' +
            '(append-only, version timestamp).',
        },
        {
          name: 'project-settings',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide settings singleton.',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `storage` — S3-like object storage with buckets + ACL.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'storage',
      description: 'S3-like object storage organized in buckets with optional public ACL.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'bucket',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A storage bucket (e.g. `avatars`, `uploads`).',
        },
        {
          name: 'object',
          parent: 'bucket',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'An object (file) at a path inside a bucket. `bounded` for one ' +
            'concrete path, `unbounded` for bulk operations.',
        },
        {
          name: 'signed-url',
          parent: 'object',
          cardinalities: ['unbounded'],
          description:
            'A signed URL emitted for a given object (exfil-risk distinct ' +
            'from a plain object read — see catalog `storage.signed-url.R`).',
        },
        {
          name: 'bucket-policy',
          parent: 'bucket',
          cardinalities: ['bounded'],
          description: 'Per-bucket storage RLS policy. Anticipated (no tool today).',
        },
        {
          name: 'storage-config',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide storage config singleton (quotas, CDN, transforms).',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `auth` — GoTrue : users, SSO, third-party providers.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'auth',
      description:
        'GoTrue authentication : users, SSO/SAML, third-party JWT providers, auth config.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'user',
          parent: 'project',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'A GoTrue user identity. `bounded` for a single id/email, ' +
            '`unbounded` for bulk listings or bulk writes.',
        },
        {
          name: 'link',
          parent: 'user',
          cardinalities: ['unbounded'],
          description:
            'A one-time auth link (magiclink, recovery, invite, signup). ' +
            'Ephemeral but takes the bearer of the URL into the user account.',
        },
        {
          name: 'mfa-factor',
          parent: 'user',
          cardinalities: ['bounded'],
          description: 'MFA factor enrolled on a user. Anticipated (no tool today).',
        },
        {
          name: 'identity',
          parent: 'user',
          cardinalities: ['bounded'],
          description:
            'A linked external OAuth identity on a user (Google, Apple, GitHub, ...). ' +
            'Anticipated (no tool today).',
        },
        {
          name: 'sso-provider',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A SAML SSO IdP registered on the project.',
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
            'Project-wide GoTrue config singleton (site URL, allow-list, JWT ' +
            'expiries, OAuth toggles, password policy, mailer).',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────────────
    // Plane `functions` — Edge Functions (Deno) + per-project secrets.
    // ─────────────────────────────────────────────────────────────────────
    {
      slug: 'functions',
      description: 'Edge Functions (Deno runtime) and the project-wide function secrets namespace.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          description: 'A Supabase project (root of this plane).',
        },
        {
          name: 'edge-function',
          parent: 'project',
          cardinalities: ['bounded'],
          description: 'A deployed edge function (by `slug`).',
        },
        {
          name: 'function-body',
          parent: 'edge-function',
          cardinalities: ['one'],
          description:
            'The current TypeScript/JavaScript source for the function. ' +
            'May contain inline secrets (anti-pattern but frequent).',
        },
        {
          name: 'function-deployment',
          parent: 'edge-function',
          cardinalities: ['bounded', 'unbounded'],
          description:
            'A deployed version of an edge function. Promotion = runtime ' +
            'mutation, immediate effect on public traffic.',
        },
        {
          name: 'function-secret',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'A project-wide secret exposed to all edge functions. NOT ' +
            'scoped per-function — namespace is project-level (see research §1.4).',
        },
        {
          name: 'functions-config',
          parent: 'project',
          cardinalities: ['one'],
          description: 'Project-wide functions config singleton.',
        },
      ],
    },
  ],
};
