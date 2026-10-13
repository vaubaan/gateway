/**
 * What the door reads off a request besides the bearer: the agent label and
 * the client origin, both for the audit entry only (spec §0 "Mission token":
 * "optional agent label"; §8 "agent label, client origin").
 *
 * Agent label — attribution, never authorization. Two carriers, because MCP
 * clients differ in what they let a user set:
 *   - the HTTP header `X-Vaubaan-Agent`, fixed for a whole client
 *     configuration (one `.mcp.json` per sub-agent);
 *   - `params._meta.agent` of a `tools/call`, set per call by an orchestrator
 *     that multiplexes several agents over one connection.
 * When both are present the per-call value wins: it is the more specific.
 *
 * Client address — resolved by the instance's single trusted-proxy rule
 * (`../http/client-ip`, shared with the request page): the right-most
 * `X-Forwarded-For` entry that is not one of the declared `trusted_proxies`.
 * The audit stores `null` where that rule answers "unknown".
 */
import type { BlockList } from 'node:net';

import type { ClientOrigin } from '@vaubaan/gateway-core';

import { clientIpOf, trustedProxyList, UNKNOWN_CLIENT } from '../http/client-ip';
import { AGENT_LABEL_HEADER, AGENT_LABEL_META_KEY } from '../missions/bootstrap-kit';

export { AGENT_LABEL_HEADER, AGENT_LABEL_META_KEY, trustedProxyList };
export const AGENT_LABEL_MAX_LENGTH = 120;
const USER_AGENT_MAX_LENGTH = 256;

/** Printable, single-line, bounded; anything else is not a label. */
export function cleanAgentLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, AGENT_LABEL_MAX_LENGTH);
}

export function agentLabelOf(headers: Headers, meta: unknown): string | null {
  const perCall =
    typeof meta === 'object' && meta !== null
      ? cleanAgentLabel((meta as Record<string, unknown>)[AGENT_LABEL_META_KEY])
      : null;
  return perCall ?? cleanAgentLabel(headers.get(AGENT_LABEL_HEADER));
}

export function clientOriginOf(
  headers: Headers,
  trusted: { readonly proxies: BlockList; readonly configured: boolean },
): ClientOrigin {
  const userAgent = headers.get('user-agent');
  const ip = clientIpOf(headers, trusted.proxies, trusted.configured);
  return {
    ip: ip === UNKNOWN_CLIENT ? null : ip,
    user_agent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
  };
}
