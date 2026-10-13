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
 * Client address — a web-standard `Request` carries no peer address, so the
 * only source is `X-Forwarded-For`, and it is believed only when the operator
 * declared the proxies in front of the instance (`trusted_proxies`): the
 * address is then the right-most entry that is not one of those proxies.
 * Without that declaration the header is client-controlled and is ignored.
 */
import { BlockList, isIP } from 'node:net';

import type { ClientOrigin } from '@vaubaan/gateway-core';

export const AGENT_LABEL_HEADER = 'x-vaubaan-agent';
export const AGENT_LABEL_META_KEY = 'agent';
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

function familyOf(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

/** A matcher over the configured `trusted_proxies` (addresses and CIDR blocks). */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = familyOf(address);
    if (!family) continue;
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

export function clientOriginOf(
  headers: Headers,
  trusted: { readonly proxies: BlockList; readonly configured: boolean },
): ClientOrigin {
  const userAgent = headers.get('user-agent');
  return {
    ip: trusted.configured ? forwardedClient(headers, trusted.proxies) : null,
    user_agent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
  };
}

function forwardedClient(headers: Headers, proxies: BlockList): string | null {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    const family = familyOf(hop);
    if (!family) return null; // a malformed chain is not evidence of anything
    if (!proxies.check(hop, family)) return hop;
  }
  return null;
}
