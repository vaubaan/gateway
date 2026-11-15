/**
 * Byte counts of a forwarded call (spec §4.2 "Activity", Overview: what went
 * up to a service and came back down, per mission).
 *
 * Counted by the pipeline when it forwards an allowed call, and written on its
 * audit entry (`request_bytes`, `response_bytes`). A refused call sent nothing
 * to the service: its entry carries no count. What a byte is depends on the
 * door, so the count is a port (`CallMeter`):
 *
 *   - the MCP door (`jsonMeter`, the default): the UTF-8 size of the call's
 *     arguments as JSON, and of the result handed back as JSON — the payloads,
 *     not their HTTP or JSON-RPC envelopes;
 *   - the git door: the bytes it relayed (a fetch's request and pack), or the
 *     pack a push carried (`CallRequest.payload_bytes`).
 *
 * A count is a fact for reading (Overview), never a limit: nothing is refused
 * on bytes.
 */
import type { CallRequest } from './pipeline.ts';

export interface CallBytes {
  /** Sent to the service; `null` when unknown. */
  readonly request_bytes: number | null;
  /** Received from the service; `null` when nothing came back whole (the call failed). */
  readonly response_bytes: number | null;
}

export interface CallMeter {
  /**
   * The counts of one forwarded call. `outcome` is the result the upstream
   * stage resolved with, or `{ failed: true }` when it threw.
   */
  measure(
    call: CallRequest,
    outcome: { readonly result: unknown } | { readonly failed: true },
  ): CallBytes;
}

const encoder = new TextEncoder();

/** UTF-8 size of a value as JSON; 0 for what JSON cannot write (`undefined`, a function). */
export function jsonBytes(value: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    // A cycle or a BigInt: no size to tell, and a count never fails a call.
    return 0;
  }
  return text === undefined ? 0 : encoder.encode(text).length;
}

/** What the call carried up: the door's own count when it gave one, else its arguments as JSON. */
export function requestBytesOf(call: CallRequest): number {
  return call.payload_bytes ?? jsonBytes(call.args);
}

/** The default meter (the MCP door): arguments up, result down, both as JSON. */
export const jsonMeter: CallMeter = {
  measure(call, outcome) {
    return {
      request_bytes: requestBytesOf(call),
      response_bytes: 'failed' in outcome ? null : jsonBytes(outcome.result),
    };
  },
};
