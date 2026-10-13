/**
 * Credential of the `upstash-redis` provider : the Upstash Management API key.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * Upstash has no OAuth app flow for its Developer (Management) API ; what v4
 * did — and what works — is a **Management API key** pasted by the user,
 * together with the account email, sent as HTTP Basic auth
 * (`email:api_key`). v5 keeps that as an `api-key` credential with two
 * fields : the email (not secret) and the API key (secret). The former
 * `email:api_key` concatenation is gone ; each fact has its own field.
 *
 * The per-database REST tokens (Data API, Bearer) are **not** part of the
 * credential : `execute` reads them from the Management API at call time
 * (`GET /v2/redis/database/{id}`), exactly as v4 did. A connection made of
 * per-database REST tokens would not be able to discover its databases,
 * nor to reach the Management API tools, so it was not retained.
 *
 * The host runs the form ; the plugin only declares it.
 */

import {
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

export const UPSTASH_API_KEYS_URL = 'https://console.upstash.com/account/api';

/** Loose email shape : one `@`, no whitespace. The provider validates the rest. */
export const UPSTASH_EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+$';

export const upstashRedisCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  createUrl: UPSTASH_API_KEYS_URL,
  fields: [
    {
      name: 'email',
      label: 'Account email',
      secret: false,
      placeholder: 'you@company.com',
      pattern: UPSTASH_EMAIL_PATTERN,
      help: 'The email of the Upstash account (or team member) that owns the API key. Sent as the Basic auth user name.',
    },
    {
      name: 'api_key',
      label: 'Management API key',
      secret: true,
      help: 'Create a key in the Upstash console → Account → Management API. The key does not expire ; revoke it in the console to end the connection.',
    },
  ],
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
  const apiKey = expectCredentialKind('upstash-redis', secret, 'api-key');
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
 * @deprecated legacy v4, deleted in P1.6. Split the v4 stored secret
 * (`email:api_key`, split on the FIRST `:` — the key may contain colons).
 */
export function parseLegacyCredentials(secret: string): UpstashAuth {
  const idx = secret.indexOf(':');
  if (idx < 0) {
    throw new Error('Upstash Redis credentials must be in `email:api_key` format.');
  }
  return { email: secret.slice(0, idx), apiKey: secret.slice(idx + 1) };
}
