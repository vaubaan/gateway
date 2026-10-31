/**
 * Credential of the `supabase` provider : a personal access token for the
 * Management API, pasted by hand (`api-key` kind), the one way of connecting.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2 ; ADR
 *        one-place-to-authorize-services-token-first.
 *
 * Supabase documents two flavours (personal-access-tokens guide, read through
 * Context7 on 2026-10-14) : a scoped token carries only the organisations,
 * projects and permissions chosen when it is created ; a classic one, marked
 * Legacy in the dashboard, carries the account's full access. Both are sent
 * as `Authorization: Bearer` to `https://api.supabase.com/v1`, so every tool
 * runs with either. The guide asks for a scoped token over the whole
 * organization with every permission the tools use (the missions narrow
 * it) ; a scoped token's permissions only narrow what the account's role
 * already allows.
 *
 * Checked at paste : `GET /v1/organizations` names the organisations the
 * token reaches (Supabase exposes no "who am I" for a token in what was read,
 * and no expiry : the expiry is the one the person chose). The projects are
 * the resources (discovery). Supabase documents no endpoint that deletes a
 * personal access token : removing an account says where to delete it.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

/** Name of the form field, and key of the secret, holding the token. */
export const SUPABASE_TOKEN_FIELD = 'access_token';

/** Where a person creates and deletes their access tokens. */
export const SUPABASE_TOKENS_PAGE = 'https://supabase.com/dashboard/account/tokens';

const SUPABASE_API = 'https://api.supabase.com/v1';

/** At most this many organisation names are kept as the token's account. */
const ACCOUNT_NAMES_SHOWN = 3;

/** Tools that reach the data plane with the project's service_role key, read through the Management API. */
const DATA_PLANE_TOOLS = [
  'supabase__list_users',
  'supabase__get_user',
  'supabase__create_user',
  'supabase__update_user',
  'supabase__delete_user',
  'supabase__generate_link',
  'supabase__create_bucket',
  'supabase__update_bucket',
  'supabase__delete_bucket',
  'supabase__list_objects',
  'supabase__upload_object',
  'supabase__delete_object',
  'supabase__create_signed_url',
] as const;

export const supabaseCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'personal access token',
  fields: [
    {
      name: SUPABASE_TOKEN_FIELD,
      label: 'Personal access token',
      secret: true,
      pattern: '^sbp_[A-Za-z0-9_]{16,200}$',
      placeholder: 'sbp_…',
      help: 'A scoped token over the organization, with every permission listed above.',
    },
  ],
  createUrl: SUPABASE_TOKENS_PAGE,
  guide: {
    steps: [
      { do: 'Sign in to Supabase as the account the agents will act as.' },
      { do: 'Open Account preferences, Access tokens, then generate a new token.' },
      {
        do: 'Choose the organization itself as the resource, not single projects.',
      },
      {
        do: 'Grant every permission below at the access shown, choose an expiry, and generate the token.',
      },
      { do: 'Copy the token and paste it here. Supabase shows it once.' },
    ],
    permissions: [
      { name: 'Project Settings', access: 'read', tools: ['supabase__get_project'] },
      {
        name: 'API Keys',
        access: 'read',
        tools: ['supabase__get_anon_key', ...DATA_PLANE_TOOLS],
      },
      { name: 'API Key Secrets', access: 'read', tools: [...DATA_PLANE_TOOLS] },
      {
        name: 'Database',
        access: 'read',
        tools: ['supabase__list_tables', 'supabase__list_migrations', 'supabase__execute_sql'],
      },
      { name: 'Migrations', access: 'read-write', tools: ['supabase__apply_migration'] },
      { name: 'Advisors', access: 'read', tools: ['supabase__get_advisors'] },
      {
        name: 'Storage Config',
        access: 'read',
        tools: ['supabase__list_buckets', 'supabase__get_storage_config'],
      },
      { name: 'Storage Config', access: 'read-write', tools: ['supabase__update_storage_config'] },
      {
        name: 'Auth Config',
        access: 'read',
        tools: [
          'supabase__get_auth_config',
          'supabase__list_sso_providers',
          'supabase__get_sso_provider',
          'supabase__list_third_party_auth',
          'supabase__get_third_party_auth',
        ],
      },
      {
        name: 'Auth Config',
        access: 'read-write',
        tools: [
          'supabase__update_auth_config',
          'supabase__create_sso_provider',
          'supabase__update_sso_provider',
          'supabase__delete_sso_provider',
          'supabase__create_third_party_auth',
          'supabase__delete_third_party_auth',
        ],
      },
      {
        name: 'Edge Functions',
        access: 'read',
        tools: [
          'supabase__list_functions',
          'supabase__get_function',
          'supabase__get_function_body',
        ],
      },
      {
        name: 'Edge Functions',
        access: 'read-write',
        tools: [
          'supabase__create_function',
          'supabase__update_function',
          'supabase__delete_function',
          'supabase__deploy_function',
        ],
      },
      { name: 'Secrets', access: 'read', tools: ['supabase__list_function_secrets'] },
      {
        name: 'Secrets',
        access: 'read-write',
        tools: ['supabase__create_function_secrets', 'supabase__delete_function_secrets'],
      },
    ],
    reach: {
      what: 'Organization and projects',
      grant: 'The organization, all of its projects, and every permission below',
      why: 'This gateway gives an agent only the projects and permissions its mission names; a token that lacks a project or a permission means a new token.',
    },
    // Supabase exposes no expiry for a token in what was read: the person chose it.
    expiry: { kind: 'person-types', recommendedDays: 90 },
    docsUrl: 'https://supabase.com/docs/guides/platform/personal-access-tokens',
  },
  verify: verifySupabaseToken,
};

/** The bearer of a Supabase connection : the pasted personal access token. */
export function supabaseBearerOf(pluginId: string, credential: CredentialSecret): string {
  const token = expectCredentialKind(pluginId, credential, 'api-key').fields[SUPABASE_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`supabase: the stored token has no '${SUPABASE_TOKEN_FIELD}' field`);
  }
  return token;
}

/**
 * The organisations the token reaches, as its account. A 401 or 403 is a
 * rejected token ; any other failure is Supabase's.
 */
export async function verifySupabaseToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const res = await ctx.fetch(`${SUPABASE_API}/organizations`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${supabaseBearerOf('supabase', ctx.credential)}`,
      Accept: 'application/json',
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`supabase rejected the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(
      `supabase GET /organizations failed with HTTP ${res.status}`,
      res.status,
    );
  }
  const body: unknown = await res.json();
  const names = (Array.isArray(body) ? body : [])
    .map((org: unknown) =>
      typeof org === 'object' &&
      org !== null &&
      typeof (org as { name?: unknown }).name === 'string'
        ? (org as { name: string }).name
        : null,
    )
    .filter((name): name is string => name !== null);
  const shown = names.slice(0, ACCOUNT_NAMES_SHOWN).join(', ');
  const more =
    names.length > ACCOUNT_NAMES_SHOWN ? ` and ${names.length - ACCOUNT_NAMES_SHOWN} more` : '';
  return { account: names.length > 0 ? `${shown}${more}` : null, expiresAt: null };
}
