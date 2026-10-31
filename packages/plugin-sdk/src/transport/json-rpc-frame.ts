/**
 * The JSON-RPC 2.0 frame that answers a request, read from a Streamable
 * HTTP body (MCP transport, revision 2025-06-18) : either one JSON document,
 * or Server-Sent Events whose `data:` lines carry frames — notifications and
 * answers to other requests included.
 */

import { isRecord } from '../guards.ts';

/** A request's answer : its `result`, or the server's error. */
export type JsonRpcFrame =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/**
 * The first frame answering `id` in `body`, or `null` when none does. An
 * error frame with a `null` id is accepted (what a server answers when it
 * could not read the request's id) ; a result never is.
 */
export function firstJsonRpcFrame(body: string, id: number): JsonRpcFrame | null {
  for (const payload of framePayloads(body)) {
    const frame = asFrame(payload, id);
    if (frame) return frame;
  }
  return null;
}

/** The candidate documents of a body : the body itself when it is one, then every SSE `data:` line. */
function framePayloads(body: string): string[] {
  const payloads: string[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) payloads.push(trimmed);
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) payloads.push(line.slice('data:'.length).trim());
  }
  return payloads;
}

function asFrame(payload: string, id: number): JsonRpcFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') return null;
  const error = parsed.error;
  if (isRecord(error)) {
    if (parsed.id !== id && parsed.id !== null) return null;
    return {
      error: {
        code: typeof error.code === 'number' ? error.code : 0,
        message: typeof error.message === 'string' ? error.message : 'no message',
      },
    };
  }
  return parsed.id === id && 'result' in parsed ? { result: parsed.result } : null;
}
