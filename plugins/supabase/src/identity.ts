/**
 * Identity of the `supabase` service — the one place its ids and Supabase's
 * own addresses are written.
 *
 * Handbook : docs/handbook/services/supabase.md ; guide : plugins/README.md, step 1.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns, the credential checks — is derived from this module, so
 * a renamed tool is a compile error everywhere it is dispatched.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'supabase';

/** `supabase__` : the prefix of every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** The MCP tool names, in the order `tools.ts` declares them. */
export const TOOL = {
  getProject: `${TOOL_PREFIX}get_project`,
  getAnonKey: `${TOOL_PREFIX}get_anon_key`,
  listTables: `${TOOL_PREFIX}list_tables`,
  listMigrations: `${TOOL_PREFIX}list_migrations`,
  executeSql: `${TOOL_PREFIX}execute_sql`,
  getAdvisors: `${TOOL_PREFIX}get_advisors`,
  applyMigration: `${TOOL_PREFIX}apply_migration`,
  listBuckets: `${TOOL_PREFIX}list_buckets`,
  getStorageConfig: `${TOOL_PREFIX}get_storage_config`,
  updateStorageConfig: `${TOOL_PREFIX}update_storage_config`,
  getAuthConfig: `${TOOL_PREFIX}get_auth_config`,
  updateAuthConfig: `${TOOL_PREFIX}update_auth_config`,
  listSsoProviders: `${TOOL_PREFIX}list_sso_providers`,
  getSsoProvider: `${TOOL_PREFIX}get_sso_provider`,
  createSsoProvider: `${TOOL_PREFIX}create_sso_provider`,
  updateSsoProvider: `${TOOL_PREFIX}update_sso_provider`,
  deleteSsoProvider: `${TOOL_PREFIX}delete_sso_provider`,
  listThirdPartyAuth: `${TOOL_PREFIX}list_third_party_auth`,
  getThirdPartyAuth: `${TOOL_PREFIX}get_third_party_auth`,
  createThirdPartyAuth: `${TOOL_PREFIX}create_third_party_auth`,
  deleteThirdPartyAuth: `${TOOL_PREFIX}delete_third_party_auth`,
  listFunctions: `${TOOL_PREFIX}list_functions`,
  getFunction: `${TOOL_PREFIX}get_function`,
  getFunctionBody: `${TOOL_PREFIX}get_function_body`,
  createFunction: `${TOOL_PREFIX}create_function`,
  updateFunction: `${TOOL_PREFIX}update_function`,
  deleteFunction: `${TOOL_PREFIX}delete_function`,
  deployFunction: `${TOOL_PREFIX}deploy_function`,
  listFunctionSecrets: `${TOOL_PREFIX}list_function_secrets`,
  createFunctionSecrets: `${TOOL_PREFIX}create_function_secrets`,
  deleteFunctionSecrets: `${TOOL_PREFIX}delete_function_secrets`,
  listUsers: `${TOOL_PREFIX}list_users`,
  getUser: `${TOOL_PREFIX}get_user`,
  createUser: `${TOOL_PREFIX}create_user`,
  updateUser: `${TOOL_PREFIX}update_user`,
  deleteUser: `${TOOL_PREFIX}delete_user`,
  generateLink: `${TOOL_PREFIX}generate_link`,
  createBucket: `${TOOL_PREFIX}create_bucket`,
  updateBucket: `${TOOL_PREFIX}update_bucket`,
  deleteBucket: `${TOOL_PREFIX}delete_bucket`,
  listObjects: `${TOOL_PREFIX}list_objects`,
  uploadObject: `${TOOL_PREFIX}upload_object`,
  deleteObject: `${TOOL_PREFIX}delete_object`,
  createSignedUrl: `${TOOL_PREFIX}create_signed_url`,
} as const;

/** A tool name of the plugin. */
export type SupabaseToolName = (typeof TOOL)[keyof typeof TOOL];

/** Public Management API of Supabase : the personal access token is its bearer. */
export const SUPABASE_API_BASE = 'https://api.supabase.com/v1';

/**
 * The API host of a project : its data plane (GoTrue admin, Storage), which
 * the `service_role` key opens. `projectRef` is a host label (`projectRefIdent`).
 */
export function projectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}
