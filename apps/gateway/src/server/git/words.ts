/**
 * What git prints when the gateway says no (spec §4.1 ter; ADR
 * gateway-as-git-remote D7). Two shapes per refusal:
 *
 *   - one line, for `ng <ref> <line>` (git shows `! [remote rejected] <ref>
 *     (<line>)`) and for an `ERR` pkt-line (`fatal: remote error: <line>`);
 *   - the refusal's `hint`, on `remote:` lines (side-band progress of a push,
 *     the body of a refused advertisement): what to do, with the URL to hand
 *     to a human.
 *
 * The words are the interface's (style guide): permissions are named by
 * their id, limits by their numbers, URLs given whole.
 */
import type { Refusal } from '@vaubaan/gateway-core';

/** Prefix of every line the gateway adds to git's output. */
export const GIT_MESSAGE_PREFIX = 'Vaubaan: ';

/** The one-line reason of a refusal. Keyed by code, so a new code fails to compile. */
const LINE_OF: { readonly [C in Refusal['code']]: (r: Extract<Refusal, { code: C }>) => string } = {
  'risk-not-accepted': (r) =>
    `${r.missing_risks.length === 1 ? 'permission' : 'permissions'} ${r.missing_risks.join(', ')} ${r.missing_risks.length === 1 ? 'is' : 'are'} not in this mission`,
  'budget-exhausted': (r) => `limit of ${r.risk_id} reached — ${r.claim_url}`,
  'approval-required': (r) => `approval required — ${r.approval_url}`,
  'resource-not-in-mission': (r) => `repository ${r.cited_ref} is not in this mission`,
  'rate-limited': (r) => `too many actions on ${r.risk_id}; retry in ${r.retry_after_seconds} s`,
  'connection-unavailable': (r) =>
    `the account ${r.connection.name} is ${r.status}; ask ${r.owner.display} to reconnect it`,
  'mission-inactive': (r) => `the mission is ${r.status}: ${r.reason}`,
  'wrong-credential-kind': (r) =>
    `this is not a mission key; the ${r.door} door expects a ${r.expected}`,
};

export function refusalLine(refusal: Refusal): string {
  const line = (LINE_OF[refusal.code] as (r: Refusal) => string)(refusal);
  return oneLine(line);
}

/** The refusal's hint, as lines git shows under `remote:`. */
export function refusalText(refusal: Refusal): string {
  return prefixed(refusal.hint);
}

/** `text` on lines of its own, each prefixed, ending with a newline. */
export function prefixed(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => `${GIT_MESSAGE_PREFIX}${line}`)
      .join('\n') + '\n'
  );
}

/** No control character, no newline: what a pkt-line reason may carry. */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
}

/** The text blocks of a tool result (`McpToolResult.content`), joined. */
export function resultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}
