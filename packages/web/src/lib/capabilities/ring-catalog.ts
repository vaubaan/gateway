/**
 * Static catalog of provider planes and their concentric levels (rings).
 *
 * Spec : docs/spec/gateway-capability-model.md §2, §2.1, §3.
 *
 * Each provider declares one or more **planes** — concentric stacks of
 * **levels** (peels), ordered niv1 (interne) → nivN (externe). The outer
 * level governs the inner ; rank = blast radius. This file is the
 * UI-side source of truth for rendering the RingGrid composer and the
 * inline documentation on the new-token page.
 *
 * NB : the runtime contract (gateway + classifier) is provider-local and
 * accepts arbitrary slugs ; this catalog is *descriptive*, not enforcing.
 * Providers that add new levels at runtime keep working even if absent
 * here ; operators can still type the notation in the free-text field.
 */

export type Action = 'read' | 'write';

export const ARCHETYPE_LABEL: Record<'content' | 'structure' | 'governance' | 'access', string> = {
  content: 'content — the living data',
  structure: 'structure — what shapes the content',
  governance: 'governance — the rules over structure',
  access: 'access — existence + creds',
};

export interface LevelDescriptor {
  /** Index in the plane ladder (1 = innermost, niv++ = outer). */
  rank: number;
  /** Provider-local slug (the value used in the notation). */
  slug: string;
  /** Optional cross-provider archetype hint (purely UX). */
  archetype: 'content' | 'structure' | 'governance' | 'access';
  /** Plain-language description shown next to the level in the UI. */
  description: string;
  /**
   * Whether typical operations on this level are env-scoped. When true the
   * UI surfaces an env selector ; when false the cap is env-less.
   */
  envScoped: boolean;
}

export interface PlaneDescriptor {
  /** Plane slug (e.g. `repo`, `runtime`, `db`). */
  slug: string;
  /** One-line summary of the plane. */
  description: string;
  /** Levels, ordered interne (niv1) → externe (nivN). */
  levels: LevelDescriptor[];
  /** Envs known a priori (Vercel: prod|preview|development). The UI will
   *  UNION this with envs harvested from the project's bindings. */
  knownEnvs: string[];
  /** UX hint for the env input (placeholder / help text). */
  envHint: string;
}

export interface ProviderDescriptor {
  /** Provider slug used by the gateway + the notation. */
  slug: string;
  /** Pretty name surfaced in the UI. */
  displayName: string;
  /** Planes this provider exposes. */
  planes: PlaneDescriptor[];
}

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    slug: 'github',
    displayName: 'GitHub',
    planes: [
      {
        slug: 'repo',
        description: 'A GitHub repository — code, CI, branch protection, access.',
        knownEnvs: ['main'],
        envHint: 'a branch name (e.g. main, feature/x, release/2026-06).',
        levels: [
          {
            rank: 1,
            slug: 'code',
            archetype: 'content',
            description: 'Files, commits, branches, pull requests, issues.',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'ci',
            archetype: 'structure',
            description: 'GitHub Actions workflows (.github/workflows/*.yml).',
            envScoped: false,
          },
          {
            rank: 3,
            slug: 'rules',
            archetype: 'governance',
            description: 'Branch protection, required reviews, merge rules.',
            envScoped: false,
          },
          {
            rank: 4,
            slug: 'access',
            archetype: 'access',
            description: 'Repo itself, collaborators, install tokens, secrets.',
            envScoped: false,
          },
        ],
      },
    ],
  },
  {
    slug: 'vercel',
    displayName: 'Vercel',
    planes: [
      {
        slug: 'runtime',
        description: 'A Vercel project — its deployments, env vars, settings.',
        knownEnvs: ['prod', 'preview', 'development'],
        envHint: 'a Vercel target — prod, preview, or development.',
        levels: [
          {
            rank: 1,
            slug: 'deployment',
            archetype: 'content',
            description: 'Built bits served + runtime/build logs (read).',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'config',
            archetype: 'structure',
            description: 'Environment variables + build settings (secrets — high blast).',
            envScoped: true,
          },
          {
            rank: 3,
            slug: 'project-settings',
            archetype: 'governance',
            description: 'Domains, deployment protection, framework config.',
            envScoped: false,
          },
          {
            rank: 4,
            slug: 'account',
            archetype: 'access',
            description: 'The project itself, team, tokens.',
            envScoped: false,
          },
        ],
      },
    ],
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    planes: [
      {
        slug: 'db',
        description: 'The Postgres database — rows, tables, RLS, project.',
        knownEnvs: ['staging', 'prod'],
        envHint: 'an environment slug from your Supabase bindings (one project per env).',
        levels: [
          {
            rank: 1,
            slug: 'rows',
            archetype: 'content',
            description:
              'Data rows. In MVP `execute_sql` is read-only ; granting write here means you exposed a write SQL path.',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'tables',
            archetype: 'structure',
            description: 'Tables, columns, migrations.',
            envScoped: true,
          },
          {
            rank: 3,
            slug: 'rls',
            archetype: 'governance',
            description: 'Row-level security policies, roles, advisors.',
            envScoped: true,
          },
          {
            rank: 4,
            slug: 'project',
            archetype: 'access',
            description: 'Project itself, API keys, connection string.',
            envScoped: true,
          },
        ],
      },
      {
        slug: 'storage',
        description: 'Object storage — files, buckets, bucket policies.',
        knownEnvs: ['staging', 'prod'],
        envHint: 'same environment slugs as the db plane (one project per env).',
        levels: [
          {
            rank: 1,
            slug: 'objects',
            archetype: 'content',
            description: 'Individual files stored in a bucket.',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'buckets',
            archetype: 'structure',
            description: 'Buckets : their names, sizes, file count.',
            envScoped: true,
          },
          {
            rank: 3,
            slug: 'storage-config',
            archetype: 'governance',
            description:
              'Bucket policies (public access, file size limits, allowed MIME types), CORS rules.',
            envScoped: true,
          },
        ],
      },
      {
        slug: 'auth',
        description: 'User identity — users, sessions, OAuth providers, JWT settings.',
        knownEnvs: ['staging', 'prod'],
        envHint: 'same environment slugs as the db plane.',
        levels: [
          {
            rank: 1,
            slug: 'users',
            archetype: 'content',
            description: 'Individual user records, sessions, password hashes.',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'providers',
            archetype: 'structure',
            description:
              'OAuth provider configuration (GitHub, Google, …) : client_id, redirect URLs.',
            envScoped: true,
          },
          {
            rank: 3,
            slug: 'auth-config',
            archetype: 'governance',
            description: 'JWT secrets, expiry, email templates, SMTP config, password policy.',
            envScoped: true,
          },
        ],
      },
      {
        slug: 'functions',
        description: 'Supabase Edge Functions — Deno runtime deployments + their config.',
        knownEnvs: ['staging', 'prod'],
        envHint: 'same environment slugs as the db plane.',
        levels: [
          {
            rank: 1,
            slug: 'deployment',
            archetype: 'content',
            description: 'Deployed function code/version + invocation logs.',
            envScoped: true,
          },
          {
            rank: 2,
            slug: 'config',
            archetype: 'structure',
            description: 'Function-level env vars, build settings.',
            envScoped: true,
          },
          {
            rank: 3,
            slug: 'functions-config',
            archetype: 'governance',
            description: 'Global function config — CORS, verify_jwt, max execution time.',
            envScoped: true,
          },
        ],
      },
    ],
  },
  {
    slug: 'railway',
    displayName: 'Railway',
    planes: [
      {
        slug: 'runtime',
        description: 'A Railway project — services, deployments, logs.',
        knownEnvs: [],
        envHint: 'env resolution not wired in MVP — leave env-less.',
        levels: [
          {
            rank: 1,
            slug: 'deployment',
            archetype: 'content',
            description: 'Services, deployments, logs.',
            envScoped: false,
          },
          {
            rank: 4,
            slug: 'account',
            archetype: 'access',
            description: 'Account-level (whoami, list-projects, create-project).',
            envScoped: false,
          },
        ],
      },
    ],
  },
  {
    slug: 'ssh',
    displayName: 'SSH',
    planes: [
      {
        slug: 'host',
        description: 'A registered SSH host — shell commands.',
        knownEnvs: [],
        envHint: 'a host slug from your SSH bindings (e.g. vps-rp).',
        levels: [
          {
            rank: 1,
            slug: 'shell',
            archetype: 'content',
            description:
              'Shell commands (`ssh__exec`). Read = whitelisted observe-only commands (uptime, ls, journalctl, …). Write = anything.',
            envScoped: true,
          },
        ],
      },
    ],
  },
];

/** Look up a provider in the catalog (UI-only — providers may exist at
 *  runtime without an entry here). */
export function providerDescriptor(slug: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.slug === slug);
}
