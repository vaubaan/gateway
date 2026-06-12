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
];
