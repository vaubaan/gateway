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
  isList,
  isRecord,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
  type TokenPermission,
} from '@vaubaan/plugin-sdk';

import { callCloudflareApi, envelopeOf, tokenOf, type Endpoint } from './cloudflare-api.ts';
import { API_TOKEN_FIELD, TOOL } from './identity.ts';

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
    tools: [TOOL.listZones, TOOL.getZone],
  },
  { name: 'Zone · Zone', access: 'read-write', tools: [TOOL.deleteZone] },
  {
    name: 'Zone · DNS',
    access: 'read-write',
    tools: [
      TOOL.listRecords,
      TOOL.getRecord,
      TOOL.exportRecords,
      TOOL.getDnssec,
      TOOL.createRecord,
      TOOL.updateRecord,
      TOOL.deleteRecord,
      TOOL.importRecords,
      TOOL.editDnssec,
    ],
  },
  {
    name: 'Zone · Zone Settings',
    access: 'read-write',
    tools: [TOOL.getZoneSettings, TOOL.editZoneSettings],
  },
  { name: 'Zone · Cache Purge', access: 'read-write', tools: [TOOL.purgeCache] },
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
        do: 'Open the page, start a token from scratch and name it.',
        path: ['My Profile', 'API Tokens', 'Create Token'],
        url: CLOUDFLARE_TOKENS_PAGE,
      },
      {
        do: 'Add a zone policy that includes all zones, with one permission per line below at the level shown (Edit for read and write, Purge for Cache Purge).',
        path: ['Policies', 'Add new policy', 'Zone policy', 'Include', 'All zones'],
        screenshot: 'create-token.webp',
      },
      {
        do: 'Leave Token expiration at no expiration or pick a date, then create the token.',
        path: ['Continue to summary', 'Create Token'],
      },
      { do: 'Copy the token and paste it here. Cloudflare shows it once.' },
    ],
    reach: {
      what: 'Zone policy',
      grant: 'Include, All zones, with every permission below',
      why: 'This gateway gives a mission its zones one by one and only the permissions it names; a token that lacks a zone or a permission means a new token.',
    },
    permissions: CLOUDFLARE_TOKEN_PERMISSIONS,
    expiry: { kind: 'provider-reports' },
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    // The Create Token form, from Cloudflare's own documentation (CC BY 4.0, the licence of
    // cloudflare/cloudflare-docs): the hard screen, where the policy is built.
    screenshots: {
      'create-token.webp': {
        source: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
        licence: 'CC-BY-4.0',
        taken: '2026-11',
        alt: 'The Create Token form of Cloudflare: a token name, a zone policy including all zones with DNS Write, the token expiration choices and Continue to summary.',
      },
    },
  },
  verify: verifyCloudflareToken,
};

/** `GET /user/tokens/verify` : `result` carries `status` and, with a TTL, `expires_on`. */
const isVerifyAnswer = envelopeOf(isRecord);

/** The first page of zones : only `account.name` of each is read. */
const isZonesAnswer = envelopeOf(isList);

const GET: Endpoint = { method: 'GET', payload: 'query' };

/**
 * The token's status and expiry (`GET /user/tokens/verify`), then the
 * accounts of the zones it lists. A token that is not active, or that lists
 * no zone (none reached, or no zone read), is refused with what to change.
 */
export async function verifyCloudflareToken(ctx: AccountContext): Promise<CredentialCheck> {
  const token = tokenOf(ctx);
  const verified = (
    await callCloudflareApi(ctx, token, GET, '/user/tokens/verify', {}, isVerifyAnswer)
  ).result;
  const status = verified.status;
  if (status !== 'active') {
    throw new CredentialRefusal(
      `Cloudflare says this token is ${typeof status === 'string' ? status : 'not active'}: create a new one under My Profile, API Tokens.`,
    );
  }
  const zones = await listZones(ctx, token);
  if (zones.length === 0) throw new CredentialRefusal(NO_ZONE);
  const accounts = [...new Set(zones.map(accountNameOf).filter((name) => name !== null))];
  return { account: namesShown(accounts), expiresAt: isoOrNull(verified.expires_on) };
}

const NO_ZONE =
  'Cloudflare: this token lists no zone. Give it Zone · Zone · Read and, in a zone policy, Include, All zones.';

/** The first page of zones ; a token refused there lacks the zone read, which is said. */
async function listZones(ctx: AccountContext, token: string): Promise<readonly unknown[]> {
  try {
    const args = { page: 1, per_page: ZONES_SAMPLE };
    return (await callCloudflareApi(ctx, token, GET, '/zones', args, isZonesAnswer)).result;
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(NO_ZONE, 403);
    }
    throw err;
  }
}

/** The name of the account a listed zone belongs to, or `null`. */
function accountNameOf(zone: unknown): string | null {
  if (!isRecord(zone) || !isRecord(zone.account)) return null;
  const name = zone.account.name;
  return typeof name === 'string' && name !== '' ? name : null;
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
