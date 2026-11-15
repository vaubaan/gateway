/**
 * The results an executor returns when the service answered. A declined
 * call is `refusalResult` (`refusal.ts`) ; a failure is thrown.
 */

import type { McpToolResult } from '@vaubaan/shared';

/** One text block. */
export function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A JSON value as one text block, indented for the agent to read. */
export function jsonResult(payload: unknown): McpToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}
