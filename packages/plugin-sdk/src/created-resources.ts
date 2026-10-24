/**
 * Reading a creating call's answer — the helper `createdResources` hooks share
 * (ADR created-resources-join-the-mission).
 *
 * A tool answer (`McpToolResult`) carries what the provider said in its
 * `structuredContent` and in its text blocks, often as JSON. `jsonValuesOf`
 * returns those values, parsed, in order : the structured content first, then
 * every text block that is a JSON document. A text block that is not JSON is
 * skipped ; nothing throws. The values are untrusted : a hook reads each ref
 * through its own grammar.
 */

import type { McpToolContent, McpToolResult } from '@vaubaan/shared';

/** Upper bound of a text block parsed as JSON : an answer, not a dump. */
export const CREATED_ANSWER_MAX_LENGTH = 1_000_000;

/** The JSON values a tool answer carries : `structuredContent`, then each JSON text block. */
export function jsonValuesOf(result: McpToolResult): unknown[] {
  const values: unknown[] = [];
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    values.push(result.structuredContent);
  }
  const blocks: readonly McpToolContent[] = Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.length > CREATED_ANSWER_MAX_LENGTH) continue;
    try {
      values.push(JSON.parse(block.text) as unknown);
    } catch {
      // Not JSON : the hook has nothing to read in this block.
    }
  }
  return values;
}

/** The plain objects among the JSON values of an answer (`jsonValuesOf`), arrays left out. */
export function jsonObjectsOf(result: McpToolResult): Record<string, unknown>[] {
  return jsonValuesOf(result).filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}
