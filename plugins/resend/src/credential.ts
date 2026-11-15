/**
 * Credential of the `resend` service : an API key with Full access, pasted
 * by hand (`api-key`), the one way of connecting.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *       grant wide at the service, the mission narrows).
 *
 * Read through Context7 on 2026-10-31 (Resend docs, "Create an API key",
 * "List domains", "Errors") : a key is made on the API keys page with the
 * permission Full access or Sending access ; a Sending access key calling
 * anything but a send is answered `401 restricted_api_key`. Resend exposes no
 * account name and no expiry : the account is named by the domains it lists
 * (`GET /domains`).
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  anyJson,
  httpJson,
  isList,
  isRecord,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { RESEND_API_BASE, authorizationOf, resendErrorName } from './execute.ts';
import { resendTools } from './tools.ts';

/** Where a person creates and deletes API keys. */
export const RESEND_API_KEYS_PAGE = 'https://resend.com/api-keys';

/** At most this many domain names are kept as the key's account. */
const DOMAIN_NAMES_SHOWN = 3;

/** Resend's error name for a Sending access key used beyond a send. */
const RESTRICTED_KEY = 'restricted_api_key';

export const resendCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'API key',
  createUrl: RESEND_API_KEYS_PAGE,
  fields: [
    {
      name: 'api_key',
      label: 'API key',
      secret: true,
      placeholder: 're_…',
      pattern: '^re_[A-Za-z0-9_-]+$',
      help: 'A Full access key. Recipient zones are set per domain on the account page after connecting.',
    },
  ],
  guide: {
    steps: [
      { do: 'Sign in to Resend as a member of the team that owns the sending domains.' },
      {
        do: 'Open the page and start a new key.',
        path: ['API Keys', 'Create API Key'],
        url: RESEND_API_KEYS_PAGE,
      },
      { do: 'Name the key, choose the Full access permission, and Add.' },
      { do: 'Copy the key and paste it here. Resend shows it once.' },
    ],
    reach: {
      what: 'Permission',
      grant: 'Full access',
      why: 'A Sending access key cannot list domains and segments, so nothing could be given to a mission; this gateway holds each send, by who it goes to, behind its own permission.',
    },
    permissions: [
      { name: 'Full access', access: 'read-write', tools: resendTools.map((tool) => tool.name) },
    ],
    expiry: {
      kind: 'none',
      reason:
        'Resend API keys do not expire: delete the key on the API Keys page to end this account.',
    },
    docsUrl: 'https://resend.com/docs/dashboard/api-keys/introduction',
  },
  verify: verifyResendKey,
};

/**
 * The domains the key lists (`GET /domains`) name its account. A Sending
 * access key is refused with the permission to choose ; any other 401 or
 * 403 is a rejected key.
 */
export async function verifyResendKey(ctx: AccountContext): Promise<CredentialCheck> {
  let body: unknown;
  try {
    body = await httpJson(
      ctx,
      {
        url: `${RESEND_API_BASE}/domains`,
        headers: authorizationOf(ctx),
        what: 'Resend GET /domains',
      },
      // Read leniently : the domains only name the account.
      anyJson,
    );
  } catch (error) {
    if (error instanceof UpstreamAuthError && resendErrorName(error) === RESTRICTED_KEY) {
      throw new CredentialRefusal(
        'Resend: this is a Sending access key. Create a key with Full access: the domains and segments cannot be listed without it.',
        error.upstreamStatus,
      );
    }
    throw error;
  }
  const data = isRecord(body) && isList(body.data) ? body.data : [];
  const names = data
    .map((domain) => (isRecord(domain) ? domain.name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '');
  return { account: namesShown(names), expiresAt: null };
}

function namesShown(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, DOMAIN_NAMES_SHOWN).join(', ');
  const more = names.length - DOMAIN_NAMES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}
