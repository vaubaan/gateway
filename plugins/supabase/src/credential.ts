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
  expectCredentialKind,
  httpJson,
  isList,
  isRecord,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, SUPABASE_API_BASE, TOOL } from './identity.ts';
import { SUPABASE_DATA_PLANE_TOOLS } from './tools.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const SUPABASE_TOKEN_FIELD = 'access_token';

/** Where a person creates and deletes their access tokens. */
export const SUPABASE_TOKENS_PAGE = 'https://supabase.com/dashboard/account/tokens';

/** At most this many organisation names are kept as the token's account. */
const ACCOUNT_NAMES_SHOWN = 3;

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
      {
        do: 'Open the page and generate a new token.',
        path: ['Account preferences', 'Access Tokens'],
        url: SUPABASE_TOKENS_PAGE,
      },
      {
        do: 'Choose the organization itself as the resource, not single projects.',
      },
      {
        do: 'Grant every permission below at the access shown, choose an expiry, and generate the token.',
      },
      { do: 'Copy the token and paste it here. Supabase shows it once.' },
    ],
    permissions: [
      { name: 'Project Settings', access: 'read', tools: [TOOL.getProject] },
      {
        name: 'API Keys',
        access: 'read',
        tools: [TOOL.getAnonKey, ...SUPABASE_DATA_PLANE_TOOLS],
      },
      { name: 'API Key Secrets', access: 'read', tools: [...SUPABASE_DATA_PLANE_TOOLS] },
      {
        name: 'Database',
        access: 'read',
        tools: [TOOL.listTables, TOOL.listMigrations, TOOL.executeSql],
      },
      { name: 'Migrations', access: 'read-write', tools: [TOOL.applyMigration] },
      { name: 'Advisors', access: 'read', tools: [TOOL.getAdvisors] },
      {
        name: 'Storage Config',
        access: 'read',
        tools: [TOOL.listBuckets, TOOL.getStorageConfig],
      },
      { name: 'Storage Config', access: 'read-write', tools: [TOOL.updateStorageConfig] },
      {
        name: 'Auth Config',
        access: 'read',
        tools: [
          TOOL.getAuthConfig,
          TOOL.listSsoProviders,
          TOOL.getSsoProvider,
          TOOL.listThirdPartyAuth,
          TOOL.getThirdPartyAuth,
        ],
      },
      {
        name: 'Auth Config',
        access: 'read-write',
        tools: [
          TOOL.updateAuthConfig,
          TOOL.createSsoProvider,
          TOOL.updateSsoProvider,
          TOOL.deleteSsoProvider,
          TOOL.createThirdPartyAuth,
          TOOL.deleteThirdPartyAuth,
        ],
      },
      {
        name: 'Edge Functions',
        access: 'read',
        tools: [TOOL.listFunctions, TOOL.getFunction, TOOL.getFunctionBody],
      },
      {
        name: 'Edge Functions',
        access: 'read-write',
        tools: [TOOL.createFunction, TOOL.updateFunction, TOOL.deleteFunction, TOOL.deployFunction],
      },
      { name: 'Secrets', access: 'read', tools: [TOOL.listFunctionSecrets] },
      {
        name: 'Secrets',
        access: 'read-write',
        tools: [TOOL.createFunctionSecrets, TOOL.deleteFunctionSecrets],
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
    throw new Error(`${PROVIDER_ID}: the stored token has no '${SUPABASE_TOKEN_FIELD}' field`);
  }
  return token;
}

/**
 * The organisations the token reaches, as its account. A 401 or 403 is a
 * rejected token (`UpstreamAuthError`) ; any other failure is Supabase's,
 * typed by `httpJson`, and so is an answer that is not a list.
 */
export async function verifySupabaseToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const organizations = await httpJson(
    ctx,
    {
      url: `${SUPABASE_API_BASE}/organizations`,
      headers: { authorization: `Bearer ${supabaseBearerOf(PROVIDER_ID, ctx.credential)}` },
    },
    isList,
  );
  // An organisation without a name names nothing : it is left out of the account.
  const names = organizations.flatMap((org) =>
    isRecord(org) && typeof org.name === 'string' ? [org.name] : [],
  );
  const shown = names.slice(0, ACCOUNT_NAMES_SHOWN).join(', ');
  const more =
    names.length > ACCOUNT_NAMES_SHOWN ? ` and ${names.length - ACCOUNT_NAMES_SHOWN} more` : '';
  return { account: names.length > 0 ? `${shown}${more}` : null, expiresAt: null };
}
