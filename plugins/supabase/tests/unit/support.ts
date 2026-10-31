/**
 * Readers the suites share, so no test casts a result or a recorded request
 * into the shape it expects : each reads it through a check and fails the
 * test when the shape is not there.
 */
import { expect } from 'vitest';

import { isRecord, type McpToolResult } from '@vaubaan/plugin-sdk';
import type { RecordedCall } from '@vaubaan/plugin-sdk/testing';

/** The text of a result's first block. */
export function resultText(result: McpToolResult): string {
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return block?.type === 'text' ? block.text : '';
}

/** A result's first block, parsed as the JSON `jsonResult` wrote. */
export function resultJson(result: McpToolResult): unknown {
  const value: unknown = JSON.parse(resultText(result));
  return value;
}

/** The SQL text a call sent to a query endpoint (`{ query }`). */
export function sentQuery(call: RecordedCall): string {
  const body = call.json;
  expect(isRecord(body) && typeof body.query === 'string').toBe(true);
  return isRecord(body) && typeof body.query === 'string' ? body.query : '';
}
