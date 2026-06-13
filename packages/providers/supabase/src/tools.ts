/**
 * Supabase MCP tools — read-only subset of the Management API + DB introspection.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (provider catalogue).
 *
 * Token model : paste-token (Management API PAT, `sbp_...`). PAT mode only —
 * Supabase OAuth Mgmt flow is Phase 5+ once we register an OAuth app.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

const projectArg = {
  project_ref: {
    type: 'string',
    description: 'Supabase project ref (the `xxx` in `xxx.supabase.co`).',
  },
};

export const availableTools: readonly McpToolDeclaration[] = [
  {
    name: 'supabase__get_project',
    description: 'Get project metadata (region, status, db version).',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__get_anon_key',
    description:
      'Get the project API URL (https://{ref}.supabase.co) and anonymous (public) API key. These are the values you need for client-side env vars (e.g. NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). The anon key is meant to be shipped in browser code — service_role is NOT returned by this tool.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__list_tables',
    description: 'List tables in the public schema (and optional extra schemas).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        schemas: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_ref'],
    },
  },
  {
    name: 'supabase__list_migrations',
    description: 'List applied migrations (supabase_migrations.schema_migrations ledger).',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__execute_sql',
    description:
      'Execute a SQL query against the project database. The required capability is computed by parsing the query: SELECT → db/rows:read, INSERT/UPDATE/DELETE → db/rows:write, CREATE/DROP/ALTER {TABLE|INDEX|VIEW|FUNCTION} → db/tables:write, CREATE/DROP POLICY + GRANT/REVOKE + ALTER … ROW LEVEL SECURITY → db/rls:write, CREATE EXTENSION + ALTER SYSTEM + VACUUM + SET → db/project:write. Multi-statement queries take the strictest required capability across statements.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, query: { type: 'string' } },
      required: ['project_ref', 'query'],
    },
  },
  {
    name: 'supabase__get_advisors',
    description: 'Get the project advisors (security/performance recommendations).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: { type: 'string', enum: ['security', 'performance'] },
      },
      required: ['project_ref', 'type'],
    },
  },
  {
    name: 'supabase__apply_migration',
    description:
      'Apply a database migration (DDL). Backed by POST /v1/projects/{ref}/database/migrations. Classified as db/tables:write — pops the human gate by default.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        name: { type: 'string', description: 'Migration name (becomes the version slug).' },
        query: { type: 'string', description: 'The SQL migration body.' },
      },
      required: ['project_ref', 'name', 'query'],
    },
  },
  {
    name: 'supabase__list_buckets',
    description:
      'List storage buckets on the project. Backed by GET /v1/projects/{ref}/storage/buckets.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__get_storage_config',
    description:
      'Get the project-wide storage config (file size limit, allowed MIME types). Backed by GET /v1/projects/{ref}/config/storage.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__get_auth_config',
    description:
      'Get the project auth config (JWT expiry, SMTP, password policy, external providers). Backed by GET /v1/projects/{ref}/config/auth.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__list_sso_providers',
    description:
      'List SAML/SSO providers configured on the project. Backed by GET /v1/projects/{ref}/config/auth/sso/providers.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__list_functions',
    description:
      'List edge functions deployed on the project. Backed by GET /v1/projects/{ref}/functions.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__get_function',
    description:
      'Get edge function metadata (verify_jwt, status, version). Backed by GET /v1/projects/{ref}/functions/{slug}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        function_slug: { type: 'string', description: 'Edge function slug.' },
      },
      required: ['project_ref', 'function_slug'],
    },
  },
  {
    name: 'supabase__get_function_body',
    description:
      'Get the edge function source body (current deployed version). Backed by GET /v1/projects/{ref}/functions/{slug}/body.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        function_slug: { type: 'string', description: 'Edge function slug.' },
      },
      required: ['project_ref', 'function_slug'],
    },
  },

  // ─── storage plane — writes ───────────────────────────────────────────────
  {
    name: 'supabase__update_storage_config',
    description:
      'Update the project-wide storage config (fileSizeLimit, features.s3Protocol.enabled, features.imageTransformation.enabled). Backed by PATCH /v1/projects/{ref}/config/storage.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        config: {
          type: 'object',
          description:
            'Partial storage config to PATCH. Common fields: fileSizeLimit (bytes), features.s3Protocol.enabled (bool), features.imageTransformation.enabled (bool).',
        },
      },
      required: ['project_ref', 'config'],
    },
  },

  // ─── auth plane — writes (config + providers) ─────────────────────────────
  {
    name: 'supabase__update_auth_config',
    description:
      'Update the project auth config (site URL, redirect allow-list, JWT/OTP expiry, password policy, mailer subjects, external OAuth toggles & client IDs/secrets). Backed by PATCH /v1/projects/{ref}/config/auth. Pass a partial `config` object — only sent fields are mutated. Common fields: site_url, uri_allow_list (comma-separated), jwt_exp, password_min_length, mailer_autoconfirm, external_google_enabled, external_google_client_id, external_google_secret, …',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        config: {
          type: 'object',
          description:
            'Partial GoTrueAuthConfig to PATCH. Call get_auth_config first to discover the current shape — every field is optional and sent fields overwrite.',
        },
      },
      required: ['project_ref', 'config'],
    },
  },
  {
    name: 'supabase__list_third_party_auth',
    description:
      'List configured third-party JWT auth providers (Firebase, Auth0, Cognito, generic OIDC issuers — federation of external JWTs). Backed by GET /v1/projects/{ref}/config/auth/third-party-auth.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__get_third_party_auth',
    description:
      'Get a single third-party JWT auth provider by id. Backed by GET /v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        tpa_id: { type: 'string', description: 'Third-party auth provider id.' },
      },
      required: ['project_ref', 'tpa_id'],
    },
  },
  {
    name: 'supabase__create_third_party_auth',
    description:
      'Register a new third-party JWT auth provider (federated JWT issuer). Backed by POST /v1/projects/{ref}/config/auth/third-party-auth.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: {
          type: 'string',
          description: 'Provider kind (e.g. `oidc`, `firebase`, `auth0`, `cognito`).',
        },
        oidc_issuer_url: {
          type: 'string',
          description: 'OIDC issuer URL (for `type: "oidc"`).',
        },
        custom_jwks_url: {
          type: 'string',
          description: 'Custom JWKS URL (for non-OIDC issuers).',
        },
        jwks_url: {
          type: 'string',
          description: 'JWKS URL — alias accepted by some providers.',
        },
      },
      required: ['project_ref', 'type'],
    },
  },
  {
    name: 'supabase__delete_third_party_auth',
    description:
      'Delete a third-party JWT auth provider by id. Backed by DELETE /v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        tpa_id: { type: 'string', description: 'Third-party auth provider id.' },
      },
      required: ['project_ref', 'tpa_id'],
    },
  },
  {
    name: 'supabase__get_sso_provider',
    description:
      'Get a single SAML/SSO provider by id. Backed by GET /v1/projects/{ref}/config/auth/sso/providers/{provider_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        provider_id: { type: 'string', description: 'SSO provider id (uuid).' },
      },
      required: ['project_ref', 'provider_id'],
    },
  },
  {
    name: 'supabase__create_sso_provider',
    description:
      'Register a new SAML/SSO provider (enterprise SSO). Backed by POST /v1/projects/{ref}/config/auth/sso/providers. Pass `metadata_url` OR `metadata_xml` (one is required by the IdP integration).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: {
          type: 'string',
          enum: ['saml'],
          description: 'Currently only `saml` is supported.',
        },
        metadata_url: {
          type: 'string',
          description: 'IdP SAML 2.0 metadata URL (HTTPS).',
        },
        metadata_xml: {
          type: 'string',
          description: 'Inline SAML 2.0 metadata XML — when `metadata_url` is not reachable.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email domains this provider auto-routes (e.g. `["acme.com"]`).',
        },
        attribute_mapping: {
          type: 'object',
          description: 'Optional SAML attribute → Supabase JWT claim mapping.',
        },
      },
      required: ['project_ref', 'type'],
    },
  },
  {
    name: 'supabase__update_sso_provider',
    description:
      'Update a SAML/SSO provider by id. Backed by PUT /v1/projects/{ref}/config/auth/sso/providers/{provider_id}. The PUT semantic on Supabase is partial — only sent fields are mutated.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        provider_id: { type: 'string', description: 'SSO provider id (uuid).' },
        metadata_url: { type: 'string' },
        metadata_xml: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        attribute_mapping: { type: 'object' },
      },
      required: ['project_ref', 'provider_id'],
    },
  },
  {
    name: 'supabase__delete_sso_provider',
    description:
      'Delete a SAML/SSO provider by id. Backed by DELETE /v1/projects/{ref}/config/auth/sso/providers/{provider_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        provider_id: { type: 'string', description: 'SSO provider id (uuid).' },
      },
      required: ['project_ref', 'provider_id'],
    },
  },

  // ─── functions plane — writes (deployment + config) ───────────────────────
  {
    name: 'supabase__create_function',
    description:
      'Create a new edge function (metadata + initial body). Backed by POST /v1/projects/{ref}/functions. For multi-file bundles, prefer `deploy_function`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        slug: { type: 'string', description: 'Edge function slug (must be unique).' },
        name: { type: 'string', description: 'Human-friendly display name.' },
        body: { type: 'string', description: 'TypeScript/JavaScript source.' },
        verify_jwt: {
          type: 'boolean',
          description: 'When true (default), require a valid Supabase JWT.',
        },
      },
      required: ['project_ref', 'slug', 'body'],
    },
  },
  {
    name: 'supabase__update_function',
    description:
      'Update edge function metadata or source body (PATCH semantics — sent fields overwrite). Backed by PATCH /v1/projects/{ref}/functions/{slug}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        function_slug: { type: 'string', description: 'Edge function slug.' },
        name: { type: 'string' },
        body: { type: 'string' },
        verify_jwt: { type: 'boolean' },
      },
      required: ['project_ref', 'function_slug'],
    },
  },
  {
    name: 'supabase__delete_function',
    description:
      'Delete an edge function. Backed by DELETE /v1/projects/{ref}/functions/{slug}. Irreversible — pops the human gate by default.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        function_slug: { type: 'string', description: 'Edge function slug.' },
      },
      required: ['project_ref', 'function_slug'],
    },
  },
  {
    name: 'supabase__deploy_function',
    description:
      'Deploy an edge function from a multi-file bundle (entrypoint + assets). Backed by POST /v1/projects/{ref}/functions/deploy?slug={slug}. Pass `files` as an array of `{name, content}` — `content` is the raw source for each file.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        slug: { type: 'string', description: 'Edge function slug (created if missing).' },
        entrypoint_path: {
          type: 'string',
          description: 'Path of the file that exports the handler (e.g. `index.ts`).',
        },
        import_map_path: {
          type: 'string',
          description: 'Optional path to a Deno import map file inside `files`.',
        },
        verify_jwt: { type: 'boolean' },
        files: {
          type: 'array',
          description: 'File bundle. Each entry: `{ name: string, content: string }`.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['name', 'content'],
          },
        },
      },
      required: ['project_ref', 'slug', 'entrypoint_path', 'files'],
    },
  },
  {
    name: 'supabase__list_function_secrets',
    description:
      'List the project secret names available to edge functions (values are not returned). Backed by GET /v1/projects/{ref}/secrets.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__create_function_secrets',
    description:
      'Set / overwrite project secrets exposed to edge functions. Backed by POST /v1/projects/{ref}/secrets with a `[{name, value}, …]` body.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        secrets: {
          type: 'array',
          description: 'Secret entries to upsert.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['project_ref', 'secrets'],
    },
  },
  {
    name: 'supabase__delete_function_secrets',
    description:
      'Delete project secrets by name. Backed by DELETE /v1/projects/{ref}/secrets with the secret names in the JSON body.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Secret names to delete.',
        },
      },
      required: ['project_ref', 'names'],
    },
  },
];
