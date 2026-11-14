/**
 * Credential of the `upstash-redis` provider : the Upstash Developer API key.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Account", §7.2.
 * ADR  : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *        grant wide at the service, the mission narrows).
 *
 * Upstash has no OAuth app flow for its Developer (Management) API ; what
 * works is a **Developer API key** pasted by the user, together with the
 * account email, sent as HTTP Basic auth (`email:api_key`). The credential
 * is an `api-key` with two fields : the email (not secret) and the API key
 * (secret) — each fact has its own field.
 *
 * Read through Context7 on 2026-10-31 (Upstash docs, Developer API
 * "Create an API key", "List Teams") : a key is made under Account,
 * Developer API, with the permission `Read/Write` or `Read Only` and an
 * expiration ; only native Upstash accounts have the Developer API ;
 * `GET /v2/teams` lists the teams of the authenticated user. No endpoint
 * read gives the key's expiry back.
 *
 * The per-database REST tokens (Data API, Bearer) are **not** part of the
 * credential : `execute` reads them from the Management API at call time
 * (`GET /v2/redis/database/{id}`). An account made of
 * per-database REST tokens would not be able to discover its databases,
 * nor to reach the Management API tools, so it was not retained.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';
import { upstashRedisTools } from './tools.ts';

/** The Upstash Developer (Management) API. A fact about the provider. */
export const UPSTASH_MANAGEMENT_API = 'https://api.upstash.com/v2';

/** Where a person creates and deletes Developer API keys. */
export const UPSTASH_API_KEYS_URL = 'https://console.upstash.com/account/api';

/** Loose email shape : one `@`, no whitespace. The provider validates the rest. */
export const UPSTASH_EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+$';

export const upstashRedisCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'Developer API key',
  createUrl: UPSTASH_API_KEYS_URL,
  fields: [
    {
      name: 'email',
      label: 'Account email',
      secret: false,
      placeholder: 'you@company.com',
      pattern: UPSTASH_EMAIL_PATTERN,
      help: 'The email of the Upstash account that owns the key: sent as the Basic auth user name.',
    },
    {
      name: 'api_key',
      label: 'Developer API key',
      secret: true,
    },
  ],
  guide: {
    steps: [
      {
        do: 'Sign in to the Upstash console with a native Upstash account: an account made through Vercel or Fly has no Developer API.',
      },
      {
        do: 'Open the page and start a new API key.',
        path: ['Account', 'Developer API', 'Create API Key'],
        url: UPSTASH_API_KEYS_URL,
      },
      { do: 'Name the key, choose the Read/Write permission and an expiration, then Submit.' },
      { do: 'Copy the key and paste it here with the account email. Upstash shows it once.' },
    ],
    reach: {
      what: 'Permission',
      grant: 'Read/Write, on the account that owns the databases',
      why: 'This gateway gives a mission only the databases and commands it names; a Read Only key cannot run the write tools, and changing that means a new key.',
    },
    permissions: [
      {
        name: 'Read/Write',
        access: 'read-write',
        tools: upstashRedisTools.map((tool) => tool.name),
      },
    ],
    // No endpoint read gives the key's expiry back: the person chose it.
    expiry: { kind: 'person-types', recommendedDays: 90 },
    docsUrl: 'https://upstash.com/docs/devops/developer-api/introduction',
  },
  verify: verifyUpstashKey,
};

/** The two facts every Management API call needs, narrowed from the decrypted secret. */
export interface UpstashAuth {
  readonly email: string;
  readonly apiKey: string;
}

/**
 * Narrow the secret the host hands the plugin. Throws `CredentialKindMismatch`
 * on the wrong kind and a plain `Error` when a field is missing — both mean a
 * host bug, not a provider error, so neither is an `UpstreamAuthError`.
 */
export function upstashAuth(secret: CredentialSecret): UpstashAuth {
  const apiKey = expectCredentialKind(PROVIDER_ID, secret, 'api-key');
  const email = apiKey.fields.email;
  const key = apiKey.fields.api_key;
  if (typeof email !== 'string' || !new RegExp(UPSTASH_EMAIL_PATTERN).test(email)) {
    throw new Error("upstash-redis credential: field 'email' is missing or is not an email");
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error("upstash-redis credential: field 'api_key' is missing");
  }
  return { email, apiKey: key };
}

/** `Basic base64(email:apiKey)` — the Management API authentication scheme. */
export function basicAuthHeader(auth: UpstashAuth): string {
  return `Basic ${Buffer.from(`${auth.email}:${auth.apiKey}`, 'utf8').toString('base64')}`;
}

/**
 * The key against the Developer API (`GET /v2/teams`, which every key may
 * read and which carries no database secret) ; the account is the email the
 * key belongs to. A 401 or 403 is a rejected key.
 */
export async function verifyUpstashKey(ctx: AccountContext): Promise<CredentialCheck> {
  const auth = upstashAuth(ctx.credential);
  const res = await ctx.fetch(`${UPSTASH_MANAGEMENT_API}/teams`, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: basicAuthHeader(auth), Accept: 'application/json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`Upstash rejected the key (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(`Upstash GET /teams failed with HTTP ${res.status}`, res.status);
  }
  return { account: auth.email, expiresAt: null };
}
