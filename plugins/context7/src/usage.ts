/**
 * The REST side of the `context7` provider : `GET https://context7.com/api/v2/usage`.
 *
 * Handbook : docs/handbook/providers/context7.md §0, §6.
 *
 * The documentation tools go through the MCP server (`execute.ts`) ; the
 * REST API is used for three things around them only : checking a pasted
 * key (`verify`), discovery, and asking about the key after the MCP server
 * answered a tool error. The usage endpoint is the one used for all three :
 * "Calls to this endpoint do not count as requests", so none of them spends
 * the key's quota. It takes no argument of the agent.
 *
 * Checked by a live call on 2026-10-16 : a bad Bearer key is answered
 * HTTP 401 here, while the MCP server answers it with an `isError` result on
 * an HTTP 200.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ConnectionContext,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { API_KEY_FIELD, PROVIDER_ID } from './identity.ts';

/** Base of Context7's public REST API : a fact about the provider. */
export const CONTEXT7_API_BASE = 'https://context7.com/api';
export const CONTEXT7_USAGE_URL = `${CONTEXT7_API_BASE}/v2/usage`;

/** Sent on every request, to the MCP server and to the REST API alike. */
export const CONTEXT7_USER_AGENT = 'vaubaan-gateway';

/** The plans `GET /v2/usage` documents (`UsageResponse.plan`). */
export const CONTEXT7_PLANS = ['free', 'pro', 'enterprise', 'payg'] as const;
export type Context7Plan = (typeof CONTEXT7_PLANS)[number];

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** The key of a Context7 connection. Thrown when the stored credential has none. */
export function context7KeyOf(credential: CredentialSecret): string {
  const key = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[API_KEY_FIELD];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${PROVIDER_ID}: the credential has no '${API_KEY_FIELD}' field`);
  }
  return key;
}

/** One `GET /v2/usage` with the key : the response, whatever its status. */
export async function requestUsage(ctx: ConnectionContext, key: string): Promise<Response> {
  return ctx.fetch(CONTEXT7_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'User-Agent': CONTEXT7_USER_AGENT,
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}

/**
 * The plan of the key's teamspace. A refused key throws `UpstreamAuthError`,
 * another failed status `UpstreamHttpError`, an answer that is not the
 * documented one a plain `Error`.
 */
export async function readPlan(ctx: ConnectionContext): Promise<Context7Plan> {
  const res = await requestUsage(ctx, context7KeyOf(ctx.credential));
  if (isKeyRefusal(res.status)) {
    throw new UpstreamAuthError(`Context7 rejected the API key (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(
      `Context7 GET /v2/usage failed with HTTP ${res.status}`,
      res.status,
    );
  }
  const body = parsedJson(await res.text());
  if (!isUsageAnswer(body)) {
    throw new Error(
      `${PROVIDER_ID}: unexpected usage answer (expected { plan: ${CONTEXT7_PLANS.join(' | ')} })`,
    );
  }
  return body.plan;
}

/** The body as JSON, or `undefined` when it is not JSON (refused by the type guard). */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isUsageAnswer(x: unknown): x is { readonly plan: Context7Plan } {
  if (typeof x !== 'object' || x === null || !('plan' in x)) return false;
  const plan = x.plan;
  return CONTEXT7_PLANS.some((known) => known === plan);
}

/** True for a status that says the key itself is refused. */
export function isKeyRefusal(status: number): boolean {
  return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN;
}
