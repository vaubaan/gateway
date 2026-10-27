/**
 * Streamed tool results — what a plugin uses when its provider answers
 * progressively (a log tail, a long export, a chunked HTTP body).
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ("Streaming : the gateway
 *        forwards streamed responses unmodified ; the decision is made
 *        before the stream starts").
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md (amendment
 *        "Streamed results").
 * Handbook : docs/handbook/plugin-sdk.md, docs/handbook/execution-door.md
 *        (Invariants, "Streaming decides first").
 *
 * The contract stays "`execute` returns one `McpToolResult`" : MCP has no
 * partial result, a `tools/call` is answered by exactly one message. What a
 * plugin gains is `ExecuteContext.emitPart` : each part handed to it leaves
 * for the caller at once (a progress notification on the call's event
 * stream, when the caller asked for progress), while `execute` keeps
 * reading the provider. The complete result is still returned at the end.
 *
 * Rules a streaming plugin follows :
 *
 *   - open the provider's response BEFORE the first `emitPart` : a rejected
 *     credential (`UpstreamAuthError`) thrown before any part is retried by
 *     the host, one thrown after a part is final (the caller already holds
 *     what was sent) ;
 *   - `await` every `emitPart` : it is the backpressure, and it rejects when
 *     the caller is gone, which is how a long stream stops ;
 *   - throw when the provider's stream breaks : the host records the call as
 *     failed after N parts ; the credit stays consumed.
 */

import type { McpToolContent, McpToolResult } from '@vaubaan/shared';

/** Receives one part of a result as soon as the provider delivered it. */
export type ToolResultPartSink = (part: McpToolContent) => Promise<void>;

/** What `streamToolResult` needs of an `ExecuteContext`. */
export interface PartEmitter {
  readonly emitPart?: ToolResultPartSink;
}

/**
 * Append a part to the content of the final result. Consecutive text parts
 * are one text block : a provider's chunk boundaries mean nothing to the
 * reader of the complete result.
 */
export function appendPart(content: McpToolContent[], part: McpToolContent): void {
  const last = content.at(-1);
  if (part.type === 'text' && last?.type === 'text') {
    content[content.length - 1] = { type: 'text', text: last.text + part.text };
    return;
  }
  content.push(part);
}

/**
 * Forward `parts` as they arrive and return the complete result : each part
 * is handed to `ctx.emitPart` (when the host provides one) and appended to
 * the final content. An error of the iteration, or of the sink, propagates ;
 * leaving the loop that way ends the iteration (`return()` on the iterator),
 * so a provider body wrapped by `textParts` is cancelled.
 */
export async function streamToolResult(
  ctx: PartEmitter,
  parts: AsyncIterable<McpToolContent>,
): Promise<McpToolResult> {
  const content: McpToolContent[] = [];
  for await (const part of parts) {
    if (ctx.emitPart) await ctx.emitPart(part);
    appendPart(content, part);
  }
  return { content };
}

/**
 * A provider's response body as text parts, one per chunk received, decoded
 * as UTF-8 across chunk boundaries. Ending the iteration early cancels the
 * body ; a body that errors makes the iteration throw.
 */
export async function* textParts(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<McpToolContent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) yield { type: 'text', text };
    }
    finished = true;
    const tail = decoder.decode();
    if (tail.length > 0) yield { type: 'text', text: tail };
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
