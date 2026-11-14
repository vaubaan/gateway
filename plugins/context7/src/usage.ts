/**
 * The REST side of the `context7` provider : `GET https://context7.com/api/v2/usage`.
 *
 * Handbook : docs/handbook/providers/context7.md.
 *
 * The documentation tools go through the MCP server (`execute.ts`) ; the
 * REST API is used for three things around them only : checking a pasted
 * key (`verify`), discovery, and asking about the key after the MCP server
 * answered a tool error. The usage endpoint is the one used for all three :
 * "Calls to this endpoint do not count as requests", so none of them spends
 * the key's quota. It takes no argument of the agent.
 *
 * Checked by live calls on 2026-10-16 : a bad Bearer key is answered
 * HTTP 401 here, while the MCP server answers it with an `isError` result on
 * an HTTP 200 ; a valid Pro key is answered HTTP 200 with
 * `{ plan, usageResetsAt, member: { requests, includedInPlan },
 * teamspace: { extraRequests, extraCostUsd, spendingLimitUsd, daily } }`,
 * `spendingLimitUsd` being `null` when no limit is set.
 */

import {
  expectCredentialKind,
  httpJson,
  isRecord,
  type AccountContext,
  type CredentialSecret,
  type Guard,
} from '@vaubaan/plugin-sdk';

import { API_KEY_FIELD, CONTEXT7_USER_AGENT, PROVIDER_ID } from './identity.ts';

/** Base of Context7's public REST API : a fact about the provider. */
export const CONTEXT7_API_BASE = 'https://context7.com/api';
export const CONTEXT7_USAGE_URL = `${CONTEXT7_API_BASE}/v2/usage`;

/** The plans `GET /v2/usage` documents (`UsageResponse.plan`). */
export const CONTEXT7_PLANS = ['free', 'pro', 'enterprise', 'payg'] as const;
export type Context7Plan = (typeof CONTEXT7_PLANS)[number];

/** How messages name the usage request. */
const USAGE_REQUEST = 'Context7 GET /v2/usage';

/** The key of a Context7 account. Thrown when the stored credential has none. */
export function context7KeyOf(credential: CredentialSecret): string {
  const key = expectCredentialKind(PROVIDER_ID, credential, 'api-key').fields[API_KEY_FIELD];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${PROVIDER_ID}: the credential has no '${API_KEY_FIELD}' field`);
  }
  return key;
}

/**
 * One `GET /v2/usage` with the key, its answer read through `guard`. Fails
 * the way `httpJson` fails : 401 / 403 `UpstreamAuthError`, another status
 * `UpstreamHttpError`, a body that is not JSON or not what `guard` accepts
 * `UpstreamProtocolError`.
 */
export async function requestUsage<T>(
  ctx: AccountContext,
  key: string,
  guard: Guard<T>,
): Promise<T> {
  return httpJson(
    ctx,
    {
      url: CONTEXT7_USAGE_URL,
      headers: { authorization: `Bearer ${key}`, 'user-agent': CONTEXT7_USER_AGENT },
      what: USAGE_REQUEST,
    },
    guard,
  );
}

/**
 * The plan of the key's teamspace. A refused key throws `UpstreamAuthError`,
 * another failed status `UpstreamHttpError`, an answer that is not the
 * documented one `UpstreamProtocolError`.
 */
export async function readPlan(ctx: AccountContext): Promise<Context7Plan> {
  const answer = await requestUsage(ctx, context7KeyOf(ctx.credential), isUsageAnswer);
  return answer.plan;
}

/**
 * True when a usage answer proves the key cannot make another request this
 * month : a Free plan whose member reached the requests the plan includes
 * (Context7 then answers 429), or a teamspace whose extra cost reached its
 * spending limit (402). A paid plan past `includedInPlan` is billed overage,
 * not blocked : not spent. Every field is type-guarded ; an absent or odd
 * field proves nothing.
 */
export function isQuotaSpent(answer: unknown): boolean {
  if (!isRecord(answer)) return false;
  const { plan, member, teamspace } = answer;
  const freeSpent =
    plan === 'free' &&
    isRecord(member) &&
    isCount(member.requests) &&
    isCount(member.includedInPlan) &&
    member.requests >= member.includedInPlan;
  const limitReached =
    isRecord(teamspace) &&
    isAmount(teamspace.spendingLimitUsd) &&
    isAmount(teamspace.extraCostUsd) &&
    teamspace.extraCostUsd >= teamspace.spendingLimitUsd;
  return freeSpent || limitReached;
}

function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function isAmount(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** A documented usage answer : its `plan` is one of `CONTEXT7_PLANS`. */
function isUsageAnswer(x: unknown): x is { readonly plan: Context7Plan } {
  if (!isRecord(x)) return false;
  const plan = x.plan;
  return CONTEXT7_PLANS.some((known) => known === plan);
}
