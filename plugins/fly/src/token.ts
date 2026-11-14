/**
 * The Fly account : an organization token pasted by hand (`api-key`).
 *
 * Handbook : docs/handbook/providers/fly.md.
 *
 * Fly offers OAuth to extension partners only, with a `read` scope : a
 * token is the only way to create and deploy. The guide asks for an
 * organization token from the dashboard's Tokens page (or `fly tokens create
 * org`, read through Context7 on 2026-10-31) : the whole organization, the
 * missions narrowing it ; no caveat to write, one visit. Tokens made by
 * `fly tokens create` and the Tokens page are macaroons sent
 * as `Authorization: FlyV1 <token>` (Fly's metrics documentation ; the
 * Machines API pages show `Bearer` for the older `fly auth token`).
 *
 * The account also names the one organization it works in, checked
 * against the token at paste, and the image prefixes a machine may run.
 */

import {
  CredentialRefusal,
  anyJson,
  expectCredentialKind,
  httpJson,
  isList,
  isRecord,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { imagePrefixesOf, slug } from './identifiers.ts';
import {
  API_TOKEN_FIELD,
  DEFAULT_IMAGE_PREFIXES,
  IMAGE_PREFIXES_FIELD,
  ORG_SLUG_FIELD,
  PROVIDER_ID,
} from './identity.ts';

/** The Machines API. A fact about the provider, not configuration. */
export const FLY_API_BASE = 'https://api.machines.dev/v1';

/** The host of the logs endpoint `fly logs` uses. */
export const FLY_LOGS_BASE = 'https://api.fly.io/api/v1';

/** The scheme `fly tokens create` tokens are sent with. */
const FLYV1 = 'FlyV1 ';

/** The dashboard's Tokens page, where a person creates and revokes organization tokens. */
export const FLY_TOKENS_PAGE = 'https://fly.io/tokens';

export const flyCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'organization token',
  createUrl: FLY_TOKENS_PAGE,
  fields: [
    {
      name: API_TOKEN_FIELD,
      label: 'Organization token',
      secret: true,
      required: true,
      placeholder: 'FlyV1 fm2_…',
      // What `fly tokens create` prints : one or more `fm1_` / `fm2_` macaroons, comma-separated.
      pattern: '^(FlyV1 )?fm[12]_[A-Za-z0-9+/=_-]{16,}(,fm[12]_[A-Za-z0-9+/=_-]{16,})*$',
      help: 'An organization token (Tokens page, or fly tokens create org), never fly auth token.',
    },
    {
      name: ORG_SLUG_FIELD,
      label: 'Organization',
      secret: false,
      required: true,
      placeholder: 'my-org',
      pattern: '^[a-z0-9][a-z0-9_-]{0,62}$',
      help: 'The slug of the Fly organization the token was created for.',
    },
    {
      name: IMAGE_PREFIXES_FIELD,
      label: 'Images machines may run',
      secret: false,
      required: false,
      placeholder: DEFAULT_IMAGE_PREFIXES.join(','),
      pattern: '^$|^[a-z0-9._/-]+(,[a-z0-9._/-]+)*$',
      help:
        'Repository prefixes, comma-separated; empty means ' +
        `${DEFAULT_IMAGE_PREFIXES.join(', ')}. Images must also be pinned by digest. ` +
        "Refresh the account's resources after changing it.",
    },
  ],
  guide: {
    steps: [
      { do: 'Sign in to Fly.io as a member of the organization the agents will work in.' },
      {
        do: 'Open the page, choose the organization, name the token vaubaan-gateway and set an expiry, then create it.',
        path: ['Tokens', 'Create Organization token'],
        url: FLY_TOKENS_PAGE,
      },
      {
        do: 'Run this instead with flyctl if you prefer the command line; it prints the same organization token.',
        code: 'fly tokens create org --org <slug> --name vaubaan-gateway --expiry 2160h',
      },
      {
        do: 'Copy the token and paste it here with the organization slug; never connect the organization that hosts this gateway.',
      },
    ],
    permissions: [],
    reach: {
      what: 'Organization',
      grant: 'One organization token for the organization the agents work in',
      why: 'Fly tokens carry no permission choice: this gateway gives an agent only the apps and permissions its mission names.',
    },
    // Fly's token description read at paste carries no expiry: the person chose it.
    expiry: { kind: 'person-types', recommendedDays: 90 },
    docsUrl: 'https://fly.io/docs/security/tokens/',
  },
  verify: verifyFlyToken,
};

/** The `Authorization` header of an account. */
export function authorizationOf(credential: CredentialSecret): string {
  const token = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[API_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${PROVIDER_ID}: the credential has no '${API_TOKEN_FIELD}' field`);
  }
  return token.startsWith(FLYV1) ? token : `${FLYV1}${token}`;
}

/** The organization slug of an account, as its form recorded it. */
export function orgSlugOf(credential: CredentialSecret): string {
  const value = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[ORG_SLUG_FIELD];
  const org = slug(value);
  if (!org)
    throw new Error(`${PROVIDER_ID}: the credential has no valid '${ORG_SLUG_FIELD}' field`);
  return org;
}

/** The image prefixes of an account ; `null` when the field is malformed. */
export function imagePrefixesOfCredential(credential: CredentialSecret): readonly string[] | null {
  return imagePrefixesOf(
    expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[IMAGE_PREFIXES_FIELD],
  );
}

/**
 * Asks Fly about the pasted token (`GET /tokens/current`) : it must answer,
 * and every macaroon it carries must be for the organization the form
 * names. A token that reaches another organization, or none, is refused.
 */
export async function verifyFlyToken(ctx: AccountContext): Promise<CredentialCheck> {
  const org = orgSlugOf(ctx.credential);
  if (!imagePrefixesOfCredential(ctx.credential)) {
    throw new CredentialRefusal(
      `${PROVIDER_ID}: '${IMAGE_PREFIXES_FIELD}' must list repository prefixes such as ghcr.io/acme/app`,
      401,
    );
  }
  // Read leniently (`anyJson`) : an answer without a token list is the
  // person's mistake (a token of another kind), told in the plugin's words.
  const body = await httpJson(
    ctx,
    {
      url: `${FLY_API_BASE}/tokens/current`,
      headers: { authorization: authorizationOf(ctx.credential) },
    },
    anyJson,
  );
  const tokens = isRecord(body) && isList(body.tokens) ? body.tokens : null;
  if (!tokens || tokens.length === 0) {
    throw new CredentialRefusal(
      'Fly did not describe the token: is it a token of fly tokens create?',
      401,
    );
  }
  const infos = tokens.filter(isRecord);
  const orgs = new Set(infos.map((info) => info.org_slug));
  if (infos.length !== tokens.length || orgs.size !== 1 || !orgs.has(org)) {
    throw new CredentialRefusal(
      `the token is not limited to the organization '${org}': create it with fly tokens create org --org ${org}`,
      401,
    );
  }
  const first = infos[0]!;
  const label =
    typeof first.organization === 'string' && first.organization ? first.organization : org;
  const apps =
    Array.isArray(first.apps) && first.apps.length > 0 ? ` (${first.apps.length} apps only)` : '';
  return { account: `the ${label} organization${apps}`, expiresAt: null };
}
