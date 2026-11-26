/**
 * MCP tools of the `supabase` service — 49 tools over the Management API
 * and the per-project data plane (GoTrue admin, Storage).
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins).
 * Handbook : docs/handbook/services/supabase.md.
 *
 * Naming : `supabase__<verb>_<noun>`, each name written once in
 * `identity.ts` (`TOOL`). Every tool takes the project ref
 * explicitly as `project_ref` (the resource ref the mission catalog lists) ;
 * the classifier falls back to the mission's single Supabase project when
 * the argument is absent.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL, type SupabaseToolName } from './identity.ts';

const projectArg = {
  project_ref: {
    type: 'string',
    description:
      'Supabase project ref (the `xxx` in `xxx.supabase.co`) or the project name, as `supabase__list_projects` lists them ; the request always carries the ref.',
  },
};

export const supabaseTools: readonly McpToolDeclaration[] = [
  // ─── the mission ───────────────────────────────────────────────────────────
  {
    name: TOOL.listProjects,
    description:
      "List the Supabase projects of this mission on this account : ref, name, environment, region. Read from the gateway, not from Supabase ; the account's other projects are left out. Name one in `project_ref` by its ref or its name.",
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── db plane ──────────────────────────────────────────────────────────────
  {
    name: TOOL.getProject,
    description: 'Get project metadata (region, status, database version).',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.getAnonKey,
    description:
      'Get the project API URL (https://{ref}.supabase.co) and the anonymous (public) API key — the values client-side env vars need (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). The anon key is meant to ship in browser code ; service_role is never returned.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.listTables,
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
    name: TOOL.listMigrations,
    description: 'List applied migrations (supabase_migrations.schema_migrations ledger).',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.executeSql,
    description:
      'Run a read-only SQL query against the project database. Executed through the Management API read-only endpoint (POST /v1/projects/{ref}/database/query/read-only) : Postgres refuses any INSERT/UPDATE/DELETE/DDL. Use apply_migration for schema changes.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, query: { type: 'string' } },
      required: ['project_ref', 'query'],
    },
  },
  {
    name: TOOL.getAdvisors,
    description: 'Get the project advisors (security or performance recommendations).',
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
    name: TOOL.applyMigration,
    description:
      'Apply a database migration. Backed by POST /v1/projects/{ref}/database/migrations. Every migration is a schema write ; statements that write rows or drop a table or a column, change RLS, privileges or extensions each add the matching risk, and SQL the gateway cannot read statement by statement (DO blocks, function, trigger or view definitions, CTEs, SET, COPY, bare SELECT) requires all of them. Migrations that write or destroy rows are refused on prod-labelled projects : keep prod migrations to plain DDL and RLS statements.',
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

  // ─── preview branches ──────────────────────────────────────────────────────
  {
    name: TOOL.listBranches,
    description:
      "List the preview branches of a project : each branch's own project ref, git branch, pull request, whether it is persistent, and the status of its migrations. Backed by GET /v1/projects/{ref}/branches. A branch is a resource of its own, labelled `preview` (a persistent branch is labelled by the account's owner) : name it by its ref in `project_ref` to query it. A branch listed here that the gateway did not know yet is known a few seconds later. A recreated branch has a new ref : find it by its git branch.",
    inputSchema: {
      type: 'object',
      properties: {
        project_ref: {
          type: 'string',
          description:
            'The parent project (ref or name, as `supabase__list_projects` lists it), never a branch.',
        },
      },
      required: ['project_ref'],
    },
  },
  {
    name: TOOL.getBranch,
    description:
      'Get the database settings of a preview branch : its ref, status, Postgres version, database host, port and user. Backed by GET /v1/branches/{ref}. The database password and the JWT secret are never returned ; `supabase__get_anon_key` on the branch gives its API URL and anon key.',
    inputSchema: {
      type: 'object',
      properties: {
        project_ref: {
          type: 'string',
          description: 'The branch, by its own ref as `supabase__list_branches` lists it.',
        },
      },
      required: ['project_ref'],
    },
  },
  {
    name: TOOL.deleteBranch,
    description:
      "Delete a preview branch : its database, storage and functions are gone. Backed by DELETE /v1/branches/{ref}. Never a project's default branch. With the GitHub integration, closing and reopening the pull request creates the branch again, under a new ref.",
    inputSchema: {
      type: 'object',
      properties: {
        project_ref: {
          type: 'string',
          description:
            'The branch to delete, by its own ref as `supabase__list_branches` lists it.',
        },
      },
      required: ['project_ref'],
    },
  },
  {
    name: TOOL.resetBranch,
    description:
      "Reset a preview branch's database : Supabase rebuilds it from the project's migrations, and the data it held is lost. Backed by POST /v1/branches/{ref}/reset ; the answer names the workflow run, and `supabase__list_branches` shows the branch's status. Never a project's default branch.",
    inputSchema: {
      type: 'object',
      properties: {
        project_ref: {
          type: 'string',
          description: 'The branch to reset, by its own ref as `supabase__list_branches` lists it.',
        },
      },
      required: ['project_ref'],
    },
  },

  // ─── storage plane — reads and configuration ───────────────────────────────
  {
    name: TOOL.listBuckets,
    description:
      'List storage buckets of the project. Backed by GET /v1/projects/{ref}/storage/buckets.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.getStorageConfig,
    description:
      'Get the project-wide storage config (file size limit, allowed MIME types). Backed by GET /v1/projects/{ref}/config/storage.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.updateStorageConfig,
    description:
      'Update the project-wide storage config (fileSizeLimit, features.s3Protocol.enabled, features.imageTransformation.enabled). Backed by PATCH /v1/projects/{ref}/config/storage.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        config: {
          type: 'object',
          description:
            'Partial storage config to PATCH. Common fields : fileSizeLimit (bytes), features.s3Protocol.enabled, features.imageTransformation.enabled.',
        },
      },
      required: ['project_ref', 'config'],
    },
  },

  // ─── auth plane — configuration and identity providers ─────────────────────
  {
    name: TOOL.getAuthConfig,
    description:
      'Get the project auth config (JWT expiry, SMTP, password policy, external providers). Secret values (OAuth client secrets, SMTP password, hook secrets, SMS provider tokens) are never returned : the gateway replaces each by a fixed marker. Backed by GET /v1/projects/{ref}/config/auth.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.updateAuthConfig,
    description:
      'Update the project auth config (site URL, redirect allow-list, JWT/OTP expiry, password policy, mailer subjects, external OAuth toggles and client ids/secrets). Backed by PATCH /v1/projects/{ref}/config/auth. Only the fields sent are mutated.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        config: {
          type: 'object',
          description:
            'Partial GoTrue auth config to PATCH. Call get_auth_config first to see the current shape.',
        },
      },
      required: ['project_ref', 'config'],
    },
  },
  {
    name: TOOL.listSsoProviders,
    description:
      'List SAML SSO providers configured on the project. Backed by GET /v1/projects/{ref}/config/auth/sso/providers.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.getSsoProvider,
    description:
      'Get one SAML SSO provider by id. Backed by GET /v1/projects/{ref}/config/auth/sso/providers/{provider_id}.',
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
    name: TOOL.createSsoProvider,
    description:
      'Register a SAML SSO provider (enterprise SSO). Backed by POST /v1/projects/{ref}/config/auth/sso/providers. Pass metadata_url or metadata_xml.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: { type: 'string', enum: ['saml'], description: 'Only `saml` is supported.' },
        metadata_url: { type: 'string', description: 'IdP SAML 2.0 metadata URL (HTTPS).' },
        metadata_xml: {
          type: 'string',
          description: 'Inline SAML 2.0 metadata XML when metadata_url is not reachable.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email domains routed to this provider (e.g. `["acme.com"]`).',
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
    name: TOOL.updateSsoProvider,
    description:
      'Update a SAML SSO provider by id. Backed by PUT /v1/projects/{ref}/config/auth/sso/providers/{provider_id} (partial : only the fields sent are mutated).',
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
    name: TOOL.deleteSsoProvider,
    description:
      'Delete a SAML SSO provider by id. Backed by DELETE /v1/projects/{ref}/config/auth/sso/providers/{provider_id}.',
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
    name: TOOL.listThirdPartyAuth,
    description:
      'List third-party JWT auth providers (Firebase, Auth0, Cognito, generic OIDC issuers). Backed by GET /v1/projects/{ref}/config/auth/third-party-auth.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.getThirdPartyAuth,
    description:
      'Get one third-party JWT auth provider by id. Backed by GET /v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}.',
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
    name: TOOL.createThirdPartyAuth,
    description:
      'Register a third-party JWT auth provider (federated JWT issuer). Backed by POST /v1/projects/{ref}/config/auth/third-party-auth.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: {
          type: 'string',
          description: 'Provider kind (`oidc`, `firebase`, `auth0`, `cognito`).',
        },
        oidc_issuer_url: { type: 'string', description: 'OIDC issuer URL (for `oidc`).' },
        custom_jwks_url: { type: 'string', description: 'Custom JWKS URL (non-OIDC issuers).' },
        jwks_url: { type: 'string', description: 'JWKS URL alias accepted by some providers.' },
      },
      required: ['project_ref', 'type'],
    },
  },
  {
    name: TOOL.deleteThirdPartyAuth,
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

  // ─── functions plane ───────────────────────────────────────────────────────
  {
    name: TOOL.listFunctions,
    description: 'List edge functions of the project. Backed by GET /v1/projects/{ref}/functions.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.getFunction,
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
    name: TOOL.getFunctionBody,
    description:
      'Get the source of the currently deployed edge function. Backed by GET /v1/projects/{ref}/functions/{slug}/body.',
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
    name: TOOL.createFunction,
    description:
      'Create an edge function (metadata and initial body). Backed by POST /v1/projects/{ref}/functions. Prefer deploy_function for multi-file bundles.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        slug: { type: 'string', description: 'Edge function slug (unique).' },
        name: { type: 'string', description: 'Display name.' },
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
    name: TOOL.updateFunction,
    description:
      'Update edge function metadata or source (PATCH semantics). Backed by PATCH /v1/projects/{ref}/functions/{slug}.',
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
    name: TOOL.deleteFunction,
    description:
      'Delete an edge function. Backed by DELETE /v1/projects/{ref}/functions/{slug}. Irreversible unless the source is in git.',
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
    name: TOOL.deployFunction,
    description:
      'Deploy an edge function from a multi-file bundle (entrypoint and assets). Backed by POST /v1/projects/{ref}/functions/deploy?slug={slug}. `files` is an array of `{ name, content }`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        slug: { type: 'string', description: 'Edge function slug (created when missing).' },
        entrypoint_path: {
          type: 'string',
          description: 'Path of the file exporting the handler (e.g. `index.ts`).',
        },
        import_map_path: {
          type: 'string',
          description: 'Optional path of a Deno import map inside `files`.',
        },
        verify_jwt: { type: 'boolean' },
        files: {
          type: 'array',
          description: 'File bundle : `{ name: string, content: string }` entries.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, content: { type: 'string' } },
            required: ['name', 'content'],
          },
        },
      },
      required: ['project_ref', 'slug', 'entrypoint_path', 'files'],
    },
  },
  {
    name: TOOL.listFunctionSecrets,
    description:
      'List the project secret names available to edge functions, with their update date. Values are never returned : the gateway replaces each by a fixed marker. Backed by GET /v1/projects/{ref}/secrets.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['project_ref'] },
  },
  {
    name: TOOL.createFunctionSecrets,
    description:
      'Set or overwrite project secrets exposed to edge functions. Backed by POST /v1/projects/{ref}/secrets with a `[{ name, value }]` body.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        secrets: {
          type: 'array',
          description: 'Secret entries to upsert.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
      required: ['project_ref', 'secrets'],
    },
  },
  {
    name: TOOL.deleteFunctionSecrets,
    description:
      'Delete project secrets by name. Backed by DELETE /v1/projects/{ref}/secrets with the names in the JSON body.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        names: { type: 'array', items: { type: 'string' }, description: 'Secret names to delete.' },
      },
      required: ['project_ref', 'names'],
    },
  },

  // ─── auth plane — users (data plane, service_role fetched gateway-side) ────
  {
    name: TOOL.listUsers,
    description:
      'List project users (GoTrue admin). The gateway fetches service_role server-side ; the key never leaves it. Backed by GET {ref}.supabase.co/auth/v1/admin/users.',
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
    name: TOOL.getUser,
    description:
      'Get one project user by id. Backed by GET {ref}.supabase.co/auth/v1/admin/users/{user_id}.',
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
    name: TOOL.createUser,
    description:
      'Create a project user. Backed by POST {ref}.supabase.co/auth/v1/admin/users. Fields : email, password, email_confirm, phone, phone_confirm, user_metadata, app_metadata, ban_duration.',
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
        ban_duration: { type: 'string', description: 'Duration such as `24h`.' },
      },
      required: ['project_ref'],
    },
  },
  {
    name: TOOL.updateUser,
    description:
      'Update a project user (fields sent overwrite). Backed by PUT {ref}.supabase.co/auth/v1/admin/users/{user_id}.',
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
        ban_duration: { type: 'string', description: 'Duration such as `24h`.' },
      },
      required: ['project_ref', 'user_id'],
    },
  },
  {
    name: TOOL.deleteUser,
    description:
      'Delete a project user by id. Backed by DELETE {ref}.supabase.co/auth/v1/admin/users/{user_id}. Irreversible ; cascades on owned rows.',
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
    name: TOOL.generateLink,
    description:
      'Generate a one-time auth link (signup, invite, magiclink, recovery, email_change_current, email_change_new). Backed by POST {ref}.supabase.co/auth/v1/admin/generate_link. The response carries `action_link`.',
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
          description: 'Post-redirect URL (must be allow-listed in the auth config).',
        },
        data: { type: 'object', description: 'Optional user_metadata set on signup.' },
      },
      required: ['project_ref', 'type', 'email'],
    },
  },

  // ─── storage plane — buckets and objects (data plane) ──────────────────────
  {
    name: TOOL.createBucket,
    description:
      'Create a storage bucket. Backed by POST {ref}.supabase.co/storage/v1/bucket. `public: true` serves objects by URL ; otherwise readers need a signed URL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        id: { type: 'string', description: 'Bucket id (slug, usually equal to `name`).' },
        name: { type: 'string', description: 'Bucket display name.' },
        public: { type: 'boolean', description: 'Objects reachable by public URL when true.' },
        file_size_limit: { type: 'number', description: 'Per-object size cap in bytes.' },
        allowed_mime_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Accepted MIME types (e.g. `image/png`).',
        },
      },
      required: ['project_ref', 'id', 'name'],
    },
  },
  {
    name: TOOL.updateBucket,
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
    name: TOOL.deleteBucket,
    description:
      'Delete a storage bucket. Backed by DELETE {ref}.supabase.co/storage/v1/bucket/{id}. The bucket must be empty.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, id: { type: 'string', description: 'Bucket id.' } },
      required: ['project_ref', 'id'],
    },
  },
  {
    name: TOOL.listObjects,
    description:
      'List objects of a bucket (prefix filter and pagination). Backed by POST {ref}.supabase.co/storage/v1/object/list/{bucket}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string', description: 'Bucket id.' },
        prefix: { type: 'string', description: 'Path prefix.' },
        limit: { type: 'number', description: 'Max entries (default 100).' },
        offset: { type: 'number', description: 'Pagination offset.' },
        sortBy: {
          type: 'object',
          description: '`{ column: "name" | "created_at" | …, order: "asc" | "desc" }`.',
        },
      },
      required: ['project_ref', 'bucket'],
    },
  },
  {
    name: TOOL.uploadObject,
    description:
      'Upload an object to a bucket. The body is sent base64-encoded and decoded gateway-side. Backed by POST {ref}.supabase.co/storage/v1/object/{bucket}/{path}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string' },
        path: { type: 'string', description: 'Object path inside the bucket (`folder/file.png`).' },
        content_base64: { type: 'string', description: 'File content, base64-encoded.' },
        content_type: {
          type: 'string',
          description: 'MIME type (default `application/octet-stream`).',
        },
        upsert: {
          type: 'boolean',
          description: 'Overwrite when the object exists (default false).',
        },
      },
      required: ['project_ref', 'bucket', 'path', 'content_base64'],
    },
  },
  {
    name: TOOL.deleteObject,
    description:
      'Delete one object. Backed by DELETE {ref}.supabase.co/storage/v1/object/{bucket}/{path}.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, bucket: { type: 'string' }, path: { type: 'string' } },
      required: ['project_ref', 'bucket', 'path'],
    },
  },
  {
    name: TOOL.createSignedUrl,
    description:
      'Issue a signed URL granting time-limited read access to a private object. Backed by POST {ref}.supabase.co/storage/v1/object/sign/{bucket}/{path}. The response carries `signedURL`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        bucket: { type: 'string' },
        path: { type: 'string' },
        expires_in: {
          type: 'number',
          description: 'TTL in seconds, 1 to 86400 (a day); default 3600.',
        },
      },
      required: ['project_ref', 'bucket', 'path'],
    },
  },
];

/** Declared tool names, for O(1) membership checks in `execute`. */
export const SUPABASE_TOOL_NAMES: ReadonlySet<string> = new Set(supabaseTools.map((t) => t.name));

/**
 * The tools that reach a project's data plane (`{ref}.supabase.co`, GoTrue
 * admin and Storage) with its `service_role` key, read through the Management
 * API for the call : `execute` routes them there, and the credential guide
 * asks for the `API Keys` and `API Key Secrets` permissions on their behalf.
 */
export const SUPABASE_DATA_PLANE_TOOLS: readonly SupabaseToolName[] = [
  TOOL.listUsers,
  TOOL.getUser,
  TOOL.createUser,
  TOOL.updateUser,
  TOOL.deleteUser,
  TOOL.generateLink,
  TOOL.createBucket,
  TOOL.updateBucket,
  TOOL.deleteBucket,
  TOOL.listObjects,
  TOOL.uploadObject,
  TOOL.deleteObject,
  TOOL.createSignedUrl,
];
