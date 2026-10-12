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

  // ─── venv — opaque secret transfer to project env var store ──────────────
  {
    name: 'supabase__service_role_to_venv',
    description:
      "Fetch the project service_role key from the Supabase Management API and store it in the project's venv (env var store). The secret value is stored server-side and NEVER returned in the tool response — only the key name and status are surfaced. Use `vercel__upsert_env_from_venv` or similar to deploy the stored value to a target environment.",
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__anon_key_to_venv',
    description:
      "Fetch the project anon (public) key from the Supabase Management API and store it in the project's venv. The value is stored server-side and NEVER returned. Useful for provisioning NEXT_PUBLIC_SUPABASE_ANON_KEY to Vercel or Railway.",
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: 'supabase__url_to_venv',
    description:
      "Store the project API URL (https://{ref}.supabase.co) in the project's venv as NEXT_PUBLIC_SUPABASE_URL. Deterministic — no API call needed.",
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },

  // ─── auth/users — data plane (gateway fetches service_role internally) ────
  {
    name: 'supabase__list_users',
    description:
      'List project users (GoTrue admin). The gateway fetches `service_role` server-side — the key never leaves the gateway. Backed by GET {ref}.supabase.co/auth/v1/admin/users.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        page: { type: 'number', description: 'Page number (1-based, default 1).' },
        per_page: { type: 'number', description: 'Page size (default 50, max 200).' },
      },
      required: ['project_ref'],
    },
  },
  {
    name: 'supabase__get_user',
    description:
      'Get a single project user by id. Backed by GET {ref}.supabase.co/auth/v1/admin/users/{user_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        user_id: { type: 'string', description: 'GoTrue user id (UUID).' },
      },
      required: ['project_ref', 'user_id'],
    },
  },
  {
    name: 'supabase__create_user',
    description:
      'Create a project user. Backed by POST {ref}.supabase.co/auth/v1/admin/users. Common fields: email, password, email_confirm, phone, phone_confirm, user_metadata, app_metadata, ban_duration.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        email: { type: 'string' },
        password: { type: 'string' },
        email_confirm: { type: 'boolean' },
        phone: { type: 'string' },
        phone_confirm: { type: 'boolean' },
        user_metadata: { type: 'object' },
        app_metadata: { type: 'object' },
        ban_duration: { type: 'string', description: 'ISO-8601 duration (e.g. `24h`).' },
      },
      required: ['project_ref'],
    },
  },
  {
    name: 'supabase__update_user',
    description:
      'Update a project user (PUT semantics — sent fields overwrite). Backed by PUT {ref}.supabase.co/auth/v1/admin/users/{user_id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        user_id: { type: 'string', description: 'GoTrue user id (UUID).' },
        email: { type: 'string' },
        password: { type: 'string' },
        email_confirm: { type: 'boolean' },
        phone: { type: 'string' },
        phone_confirm: { type: 'boolean' },
        user_metadata: { type: 'object' },
        app_metadata: { type: 'object' },
        ban_duration: { type: 'string', description: 'ISO-8601 duration (e.g. `24h`).' },
      },
      required: ['project_ref', 'user_id'],
    },
  },
  {
    name: 'supabase__delete_user',
    description:
      'Delete a project user by id. Backed by DELETE {ref}.supabase.co/auth/v1/admin/users/{user_id}. Irreversible — pops the human gate by default.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        user_id: { type: 'string', description: 'GoTrue user id (UUID).' },
      },
      required: ['project_ref', 'user_id'],
    },
  },
  {
    name: 'supabase__generate_link',
    description:
      'Generate a one-time auth link (signup / invite / magiclink / recovery / email_change_current / email_change_new). Backed by POST {ref}.supabase.co/auth/v1/admin/generate_link. Response includes `action_link` (URL).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: {
          type: 'string',
          enum: [
            'signup',
            'invite',
            'magiclink',
            'recovery',
            'email_change_current',
            'email_change_new',
          ],
          description: 'Link kind.',
        },
        email: { type: 'string', description: 'Target email.' },
        password: { type: 'string', description: 'For `type: signup`.' },
        new_email: { type: 'string', description: 'For `type: email_change_*`.' },
        redirect_to: {
          type: 'string',
          description: 'Post-redirect URL (allow-listed in auth config).',
        },
        data: { type: 'object', description: 'Optional user_metadata to set on signup.' },
      },
      required: ['project_ref', 'type', 'email'],
    },
  },

  // ─── storage/buckets — data plane writes ─────────────────────────────────
  {
    name: 'supabase__create_bucket',
    description:
      'Create a storage bucket. Backed by POST {ref}.supabase.co/storage/v1/bucket. Set `public: true` for a public-read bucket (URL-served), otherwise consumers need a signed URL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        id: { type: 'string', description: 'Bucket id (slug — usually same as `name`).' },
        name: { type: 'string', description: 'Bucket display name.' },
        public: { type: 'boolean', description: 'If true, objects are reachable by public URL.' },
        file_size_limit: { type: 'number', description: 'Per-object byte size cap.' },
        allowed_mime_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'MIME types accepted (e.g. `image/png`).',
        },
      },
      required: ['project_ref', 'id', 'name'],
    },
  },
  {
    name: 'supabase__update_bucket',
    description:
      'Update a storage bucket (public flag, size limit, MIME list). Backed by PUT {ref}.supabase.co/storage/v1/bucket/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        id: { type: 'string', description: 'Bucket id.' },
        public: { type: 'boolean' },
        file_size_limit: { type: 'number' },
        allowed_mime_types: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_ref', 'id'],
    },
  },
  {
    name: 'supabase__delete_bucket',
    description:
      'Delete a storage bucket. Backed by DELETE {ref}.supabase.co/storage/v1/bucket/{id}. Bucket must be empty (use list_objects + delete_object first).',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, id: { type: 'string', description: 'Bucket id.' } },
      required: ['project_ref', 'id'],
    },
  },

  // ─── storage/objects — data plane ────────────────────────────────────────
  {
    name: 'supabase__list_objects',
    description:
      'List objects in a bucket (with prefix filter + pagination). Backed by POST {ref}.supabase.co/storage/v1/object/list/{bucket}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string', description: 'Bucket id.' },
        prefix: { type: 'string', description: 'Path prefix to scope the listing.' },
        limit: { type: 'number', description: 'Max entries (default 100).' },
        offset: { type: 'number', description: 'Pagination offset.' },
        sortBy: {
          type: 'object',
          description: '`{ column: "name"|"created_at"|…, order: "asc"|"desc" }`.',
        },
      },
      required: ['project_ref', 'bucket'],
    },
  },
  {
    name: 'supabase__upload_object',
    description:
      'Upload an object to a bucket. The body is sent as base64 (decoded gateway-side). Backed by POST {ref}.supabase.co/storage/v1/object/{bucket}/{path}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string' },
        path: {
          type: 'string',
          description: 'Object path inside the bucket (e.g. `folder/file.png`).',
        },
        content_base64: { type: 'string', description: 'File content base64-encoded.' },
        content_type: {
          type: 'string',
          description: 'MIME type (defaults to `application/octet-stream`).',
        },
        upsert: {
          type: 'boolean',
          description: 'Overwrite if the object already exists (default false).',
        },
      },
      required: ['project_ref', 'bucket', 'path', 'content_base64'],
    },
  },
  {
    name: 'supabase__delete_object',
    description:
      'Delete a single object. Backed by DELETE {ref}.supabase.co/storage/v1/object/{bucket}/{path}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['project_ref', 'bucket', 'path'],
    },
  },
  {
    name: 'supabase__create_signed_url',
    description:
      'Issue a signed URL for time-limited read access to a private object. Backed by POST {ref}.supabase.co/storage/v1/object/sign/{bucket}/{path}. Response includes `signedURL`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string' },
        path: { type: 'string' },
        expires_in: {
          type: 'number',
          description: 'TTL in seconds (default 3600).',
        },
      },
      required: ['project_ref', 'bucket', 'path'],
    },
  },
];
