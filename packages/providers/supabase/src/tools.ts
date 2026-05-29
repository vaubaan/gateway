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
      'Execute a SQL query (read-only by convention — INSERT/UPDATE/DELETE will land but the role is meant for SELECT).',
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
];
