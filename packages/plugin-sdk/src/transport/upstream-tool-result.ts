/**
 * An upstream MCP server's tool result, read into the gateway's
 * `McpToolResult` : what a rewrapping plugin passes through to the agent
 * (ADR rewrap-official-mcps). The answer is untrusted, so it is rebuilt from
 * what the reader recognises, never forwarded as an object.
 */

import type { McpToolContent, McpToolResult } from '@vaubaan/shared';

import { isList, isRecord } from '../guards.ts';
import { UpstreamProtocolError } from './errors.ts';

/**
 * `result` as a tool result : `content` required, `structuredContent` kept
 * when it is an object, `isError: true` kept (the provider's own refusal,
 * which the agent reads). A text, image or resource block is copied field by
 * field ; a block of any other type (audio, a type MCP clients may not know)
 * becomes its JSON as text. Not a tool result : `UpstreamProtocolError`
 * naming `what`.
 */
export function upstreamToolResult(result: unknown, what: string): McpToolResult {
  if (!isRecord(result) || !isList(result.content)) {
    throw new UpstreamProtocolError(`${what}: the answer is not a tool result`);
  }
  const structured = result.structuredContent;
  return {
    content: result.content.map(contentBlock),
    ...(isRecord(structured) ? { structuredContent: structured } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function contentBlock(block: unknown): McpToolContent {
  if (!isRecord(block)) return { type: 'text', text: JSON.stringify(block) };
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (
    block.type === 'image' &&
    typeof block.data === 'string' &&
    typeof block.mimeType === 'string'
  ) {
    return { type: 'image', data: block.data, mimeType: block.mimeType };
  }
  const resource = block.resource;
  if (block.type === 'resource' && isRecord(resource) && typeof resource.uri === 'string') {
    return {
      type: 'resource',
      resource: {
        uri: resource.uri,
        ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
        ...(typeof resource.text === 'string' ? { text: resource.text } : {}),
      },
    };
  }
  return { type: 'text', text: JSON.stringify(block) };
}
