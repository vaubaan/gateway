/**
 * What the door reads off a request besides the bearer: the agent label and
 * the client origin, both for the audit entry only (spec §0 "Mission token":
 * "optional agent label"; §7.9; §8 "agent label, client origin").
 *
 * Agent label — attribution, never authorization, never an identity. The
 * caller declares it; nothing proves it. Two carriers, because MCP clients
 * differ in what they let a user set:
 *   - `params._meta.agent` of a `tools/call`, set per call by an orchestrator
 *     that multiplexes several agents over one connection;
 *   - the HTTP header `X-Vaubaan-Agent`, fixed for a whole client
 *     configuration (one `.mcp.json` per sub-agent).
 * Precedence: the per-call value wins, it is the more specific. A carrier
 * that holds no label (absent, empty, blank) or a rejected one leaves the
 * place to the next.
 *
 * Shape: 1 to `AGENT_LABEL_MAX_LENGTH` (64) characters, ASCII letters and
 * digits plus `. _ - : / @ +`, starting with a letter or a digit; surrounding
 * whitespace is trimmed. Anything else is REJECTED, not repaired: the label
 * is dropped, the door logs why (never the value), and the call proceeds
 * exactly as if no label had been sent. A label never causes a refusal.
 *
 * Client address — resolved by the instance's single trusted-proxy rule
 * (`../http/client-ip`, shared with the request page): the right-most
 * `X-Forwarded-For` entry that is not one of the declared `trusted_proxies`.
 * The audit stores `null` where that rule answers "unknown".
 */
import type { BlockList } from 'node:net';

import type { ClientOrigin } from '@vaubaan/gateway-core';

import { clientIpOf, trustedProxyList, UNKNOWN_CLIENT } from '../http/client-ip';
import {
  AGENT_LABEL_HEADER,
  AGENT_LABEL_MAX_LENGTH,
  AGENT_LABEL_META_KEY,
  AGENT_LABEL_PUNCTUATION,
} from '../missions/bootstrap-kit';

export { AGENT_LABEL_HEADER, AGENT_LABEL_MAX_LENGTH, AGENT_LABEL_META_KEY, trustedProxyList };
/**
 * The characters of a label, built from the list the bootstrap kit prints, so
 * the door checks exactly what the agents are told. Its length is checked
 * apart, to name the reason.
 */
const AGENT_LABEL_SHAPE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9${AGENT_LABEL_PUNCTUATION.replace(/[\\\]^-]/g, '\\$&')}]*$`,
);
const USER_AGENT_MAX_LENGTH = 256;

/** Where a label travels, in precedence order. */
export const AGENT_LABEL_CARRIERS = ['meta', 'header'] as const;
export type AgentLabelCarrier = (typeof AGENT_LABEL_CARRIERS)[number];

export type AgentLabelRejection = 'not-a-string' | 'too-long' | 'invalid-character';

export type AgentLabelParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'label'; readonly label: string }
  | {
      readonly kind: 'rejected';
      readonly reason: AgentLabelRejection;
      /** Length of the trimmed value; `null` when it was not a string. Never the value. */
      readonly length: number | null;
    };

/** One carrier's value, read against the label's shape. Pure. */
export function parseAgentLabel(raw: unknown): AgentLabelParse {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'rejected', reason: 'not-a-string', length: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed.length > AGENT_LABEL_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'too-long', length: trimmed.length };
  }
  if (!AGENT_LABEL_SHAPE.test(trimmed)) {
    return { kind: 'rejected', reason: 'invalid-character', length: trimmed.length };
  }
  return { kind: 'label', label: trimmed };
}

export interface DroppedAgentLabel {
  readonly carrier: AgentLabelCarrier;
  readonly reason: AgentLabelRejection;
  readonly length: number | null;
}

export interface AgentLabelReading {
  readonly label: string | null;
  /** The carrier the label came from; `null` when there is none. */
  readonly carrier: AgentLabelCarrier | null;
  /** Carriers whose value was rejected before the label (or its absence) was settled. */
  readonly dropped: readonly DroppedAgentLabel[];
}

/** The label of one `tools/call`: `_meta.agent` first, then the header. */
export function readAgentLabel(headers: Headers, meta: unknown): AgentLabelReading {
  const values: Record<AgentLabelCarrier, unknown> = {
    meta:
      typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)[AGENT_LABEL_META_KEY]
        : undefined,
    header: headers.get(AGENT_LABEL_HEADER),
  };
  const dropped: DroppedAgentLabel[] = [];
  for (const carrier of AGENT_LABEL_CARRIERS) {
    const parsed = parseAgentLabel(values[carrier]);
    if (parsed.kind === 'label') return { label: parsed.label, carrier, dropped };
    if (parsed.kind === 'rejected') {
      dropped.push({ carrier, reason: parsed.reason, length: parsed.length });
    }
  }
  return { label: null, carrier: null, dropped };
}

export function agentLabelOf(headers: Headers, meta: unknown): string | null {
  return readAgentLabel(headers, meta).label;
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
