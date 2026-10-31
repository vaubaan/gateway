/**
 * Credential of the `cloudflare-dns` provider : a user API token pasted by
 * hand (`api-key`), the one way of connecting.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *       grant wide at the service, the mission narrows).
 *
 * Read through Context7 on 2026-10-31 (Cloudflare docs, "Create API token",
 * "Verify a token", the DNS / Zone Settings API references) : a custom token
 * is made under My Profile, API Tokens ; each permission row is a group
 * (Zone), an item (DNS, Zone Settings…) and a level (Read, Edit) ; Zone
 * Resources choose which zones it reaches ; TTL is optional.
 * `GET /user/tokens/verify` answers `status` and, when a TTL was set,
 * `expires_on`. It names no account : the account names come from the zones
 * the token lists (`GET /zones`, first page).
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type TokenPermission,
} from '@vaubaan/plugin-sdk';

import { API_TOKEN_FIELD, CLOUDFLARE_API_BASE, tokenOf } from './execute.ts';

/** Where a person creates and deletes their user API tokens. */
export const CLOUDFLARE_TOKENS_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

/** At most this many account names are kept as the token's account. */
const ACCOUNT_NAMES_SHOWN = 3;

/** The zones read to name the accounts : one page is enough to name them. */
const ZONES_SAMPLE = 50;

/** The token's permission rows, as the token builder names them, with the tools each serves. */
export const CLOUDFLARE_TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  {
    name: 'Zone · Zone',
    access: 'read',
    tools: ['cloudflare_dns__list_zones', 'cloudflare_dns__get_zone'],
  },
  { name: 'Zone · Zone', access: 'read-write', tools: ['cloudflare_dns__delete_zone'] },
  {
    name: 'Zone · DNS',
    access: 'read-write',
    tools: [
      'cloudflare_dns__list_records',
      'cloudflare_dns__get_record',
      'cloudflare_dns__export_records',
      'cloudflare_dns__get_dnssec',
      'cloudflare_dns__create_record',
      'cloudflare_dns__update_record',
      'cloudflare_dns__delete_record',
      'cloudflare_dns__import_records',
      'cloudflare_dns__edit_dnssec',
    ],
  },
  {
    name: 'Zone · Zone Settings',
    access: 'read-write',
    tools: ['cloudflare_dns__get_zone_settings', 'cloudflare_dns__edit_zone_settings'],
  },
  { name: 'Zone · Cache Purge', access: 'read-write', tools: ['cloudflare_dns__purge_cache'] },
];

export const cloudflareDnsCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'API token',
  createUrl: CLOUDFLARE_TOKENS_PAGE,
  fields: [
    {
      name: API_TOKEN_FIELD,
      label: 'API token',
      secret: true,
      required: true,
      placeholder: 'Cloudflare API token',
      // Tokens are URL-safe base64-ish strings (`cfut_…` for new ones) ; a
      // Global API Key pasted as `email|key` is refused by construction.
      pattern: '^[A-Za-z0-9_-]{20,}$',
      help: 'A custom API token, never the Global API Key.',
    },
  ],
  guide: {
    steps: [
      { do: 'Sign in to Cloudflare as a member of the account that owns the zones.' },
      {
        do: 'Open My Profile, API Tokens, choose Create Token, then Create Custom Token.',
        url: CLOUDFLARE_TOKENS_PAGE,
      },
      {
        do: 'Add one permission row per line below, at the level shown (Edit for read and write, Purge for Cache Purge).',
      },
      { do: 'Choose Include, All zones under Zone Resources.' },
      {
        do: 'Leave the TTL empty or set an end date, choose Continue to summary, then Create Token.',
      },
      { do: 'Copy the token and paste it here. Cloudflare shows it once.' },
    ],
    reach: {
      what: 'Zone Resources',
      grant: 'Include, All zones, with every permission below',
      why: 'This gateway gives a mission its zones one by one and only the permissions it names; a token that lacks a zone or a permission means a new token.',
    },
    permissions: CLOUDFLARE_TOKEN_PERMISSIONS,
    expiry: { kind: 'provider-reports' },
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  },
  verify: verifyCloudflareToken,
};

interface VerifyDto {
  readonly result?: { readonly status?: unknown; readonly expires_on?: unknown };
}

interface ZonesDto {
  readonly result?: readonly { readonly account?: { readonly name?: unknown } }[];
}

/**
 * The token's status and expiry (`GET /user/tokens/verify`), then the
 * accounts of the zones it lists. A token that is not active, or that lists
 * no zone (none reached, or no zone read), is refused with what to change.
 */
export async function verifyCloudflareToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const verified = (await cloudflareGet(ctx, '/user/tokens/verify')) as VerifyDto;
  const status = verified.result?.status;
  if (status !== 'active') {
    throw new CredentialRefusal(
      `Cloudflare says this token is ${typeof status === 'string' ? status : 'not active'}: create a new one under My Profile, API Tokens.`,
    );
  }
  const zones = (await listZones(ctx)).result ?? [];
  if (zones.length === 0) throw new CredentialRefusal(NO_ZONE);
  const accounts = [
    ...new Set(
      zones
        .map((zone) => zone.account?.name)
        .filter((name): name is string => typeof name === 'string' && name !== ''),
    ),
  ];
  return { account: namesShown(accounts), expiresAt: isoOrNull(verified.result?.expires_on) };
}

const NO_ZONE =
  'Cloudflare: this token lists no zone. Give it Zone · Zone · Read and, under Zone Resources, Include, All zones.';

/** The first page of zones ; a token refused there lacks the zone read, which is said. */
async function listZones(ctx: ConnectionContext): Promise<ZonesDto> {
  try {
    return (await cloudflareGet(ctx, `/zones?page=1&per_page=${ZONES_SAMPLE}`)) as ZonesDto;
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(NO_ZONE, 403);
    }
    throw err;
  }
}

async function cloudflareGet(ctx: ConnectionContext, path: string): Promise<unknown> {
  const res = await ctx.fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenOf(ctx)}`, Accept: 'application/json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`Cloudflare rejected the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(
      `Cloudflare GET ${path} failed with HTTP ${res.status}`,
      res.status,
    );
  }
  return res.json();
}

function namesShown(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, ACCOUNT_NAMES_SHOWN).join(', ');
  const more = names.length - ACCOUNT_NAMES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
