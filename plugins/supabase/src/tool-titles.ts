/**
 * What each tool of the `supabase` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const supabaseToolTitles: Readonly<Record<string, string>> = {
  supabase__get_project: 'Read the project',
  supabase__get_anon_key: 'Read the API URL and the anonymous key',
  supabase__list_tables: 'List tables',
  supabase__list_migrations: 'List applied migrations',
  supabase__execute_sql: 'Run a read-only SQL query',
  supabase__get_advisors: 'Read the advisors',
  supabase__apply_migration: 'Apply a database migration',
  supabase__list_buckets: 'List storage buckets',
  supabase__get_storage_config: 'Read the storage configuration',
  supabase__update_storage_config: 'Change the storage configuration',
  supabase__get_auth_config: 'Read the sign-in configuration',
  supabase__update_auth_config: 'Change the sign-in configuration',
  supabase__list_sso_providers: 'List SSO providers',
  supabase__get_sso_provider: 'Read an SSO provider',
  supabase__create_sso_provider: 'Register an SSO provider',
  supabase__update_sso_provider: 'Change an SSO provider',
  supabase__delete_sso_provider: 'Delete an SSO provider',
  supabase__list_third_party_auth: 'List third-party sign-in providers',
  supabase__get_third_party_auth: 'Read a third-party sign-in provider',
  supabase__create_third_party_auth: 'Register a third-party sign-in provider',
  supabase__delete_third_party_auth: 'Delete a third-party sign-in provider',
  supabase__list_functions: 'List edge functions',
  supabase__get_function: 'Read an edge function',
  supabase__get_function_body: 'Read the source of an edge function',
  supabase__create_function: 'Create an edge function',
  supabase__update_function: 'Change an edge function',
  supabase__delete_function: 'Delete an edge function',
  supabase__deploy_function: 'Deploy an edge function',
  supabase__list_function_secrets: 'List the names of function secrets',
  supabase__create_function_secrets: 'Set function secrets',
  supabase__delete_function_secrets: 'Delete function secrets',
  supabase__list_users: 'List users',
  supabase__get_user: 'Read a user',
  supabase__create_user: 'Create a user',
  supabase__update_user: 'Change a user',
  supabase__delete_user: 'Delete a user',
  supabase__generate_link: 'Generate a one-time sign-in link',
  supabase__create_bucket: 'Create a storage bucket',
  supabase__update_bucket: 'Change a storage bucket',
  supabase__delete_bucket: 'Delete a storage bucket',
  supabase__list_objects: 'List the objects of a bucket',
  supabase__upload_object: 'Upload an object',
  supabase__delete_object: 'Delete an object',
  supabase__create_signed_url: 'Create a signed URL for an object',
};
