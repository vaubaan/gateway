/**
 * The Fly connection : an organization token pasted by hand (`api-key`).
 *
 * Handbook : docs/handbook/providers/fly.md §6.1.
 *
 * Fly offers OAuth to extension partners only, with a `read` scope : a
 * token is the only way to create and deploy. The recommended token is
 * `fly tokens create org`, attenuated with the `NoAdminFeatures` caveat
 * (`fly tokens attenuate`) so that it cannot touch billing, membership or the
 * organization itself. Tokens made by `fly tokens create` are macaroons sent
 * as `Authorization: FlyV1 <token>` (Fly's metrics documentation ; the
 * Machines API pages show `Bearer` for the older `fly auth token`).
 *
 * The connection also names the one organization it works in, checked
 * against the token at paste, and the image prefixes a machine may run.
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

import { imagePrefixesOf, isRecord, slug } from './identifiers.ts';
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

/** Where a person creates and revokes organization tokens. */
export const FLY_TOKENS_PAGE = 'https://fly.io/dashboard';

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
      help: 'From `fly tokens create org`, attenuated with NoAdminFeatures. Never `fly auth token`.',
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
      'Install flyctl and sign in as a member of the organization the agents will work in.',
      'Create an organization token: fly tokens create org --org <slug> --name vaubaan-gateway --expiry 2160h.',
      'Attenuate it so it cannot touch billing, membership or the organization itself: write [{"type":"NoAdminFeatures","body":{}}] to caveats.json, then run fly tokens attenuate -f caveats.json -t "<token>".',
      'Paste the attenuated token here, with the organization slug. Keep the organization that hosts this gateway separate: never connect it here.',
      'Fly tokens carry no permission choice beyond their caveats: Vaubaan decides who may do what.',
    ],
    permissions: [],
    recommendedExpiryDays: 90,
    docsUrl: 'https://fly.io/docs/security/tokens/',
  },
  manualRevocation:
    'Revoke the token in the Fly dashboard (organization, Tokens) or with fly tokens revoke <id>.',
  verify: verifyFlyToken,
};

/** The `Authorization` header of a connection. */
export function authorizationOf(credential: CredentialSecret): string {
  const token = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[API_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${PROVIDER_ID}: the credential has no '${API_TOKEN_FIELD}' field`);
  }
  return token.startsWith(FLYV1) ? token : `${FLYV1}${token}`;
}

/** The organization slug of a connection, as its form recorded it. */
export function orgSlugOf(credential: CredentialSecret): string {
  const value = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[ORG_SLUG_FIELD];
  const org = slug(value);
  if (!org)
    throw new Error(`${PROVIDER_ID}: the credential has no valid '${ORG_SLUG_FIELD}' field`);
  return org;
}

/** The image prefixes of a connection ; `null` when the field is malformed. */
export function imagePrefixesOfCredential(credential: CredentialSecret): readonly string[] | null {
  return imagePrefixesOf(
    expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[IMAGE_PREFIXES_FIELD],
  );
}

interface TokenInfo {
  readonly org_slug?: unknown;
  readonly organization?: unknown;
  readonly apps?: unknown;
}

/**
 * Asks Fly about the pasted token (`GET /tokens/current`) : it must answer,
 * and every macaroon it carries must be for the organization the form
 * names. A token that reaches another organization, or none, is refused.
 */
export async function verifyFlyToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const org = orgSlugOf(ctx.credential);
  if (!imagePrefixesOfCredential(ctx.credential)) {
    throw new UpstreamAuthError(
      `${PROVIDER_ID}: '${IMAGE_PREFIXES_FIELD}' must list repository prefixes such as ghcr.io/acme/app`,
      401,
    );
  }
  const res = await ctx.fetch(`${FLY_API_BASE}/tokens/current`, {
    method: 'GET',
    headers: { authorization: authorizationOf(ctx.credential), accept: 'application/json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`Fly refused the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok)
    throw new UpstreamHttpError(
      `Fly GET /tokens/current failed with HTTP ${res.status}`,
      res.status,
    );
  const body: unknown = await res.json();
  const tokens = isRecord(body) && Array.isArray(body.tokens) ? (body.tokens as unknown[]) : null;
  if (!tokens || tokens.length === 0) {
    throw new UpstreamAuthError(
      'Fly did not describe the token: is it a token of fly tokens create?',
      401,
    );
  }
  const infos = tokens.filter(isRecord) as TokenInfo[];
  const orgs = new Set(infos.map((info) => info.org_slug));
  if (infos.length !== tokens.length || orgs.size !== 1 || !orgs.has(org)) {
    throw new UpstreamAuthError(
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
