/**
 * The two failures a provider can cause besides a failed status : an answer
 * the protocol does not allow, and an answer larger than the plugin reads.
 *
 * Both are an `UpstreamHttpError` (status 502, "bad gateway") : the host
 * records them as the provider's failure (`upstream_error`, "the provider
 * answered HTTP 502"), the agent reads the message, and telemetry never
 * files them as a fault of the plugin — which a plain `Error` would be
 * (`refusal.ts`).
 */

import { UpstreamHttpError } from '@vaubaan/shared';

/** The status a protocol failure carries : the provider is a bad gateway for the call. */
export const PROTOCOL_FAILURE_STATUS = 502;

/**
 * The provider answered, but not what its protocol says : a JSON-RPC error
 * frame, a body that is not JSON, a document of the wrong shape, no frame
 * answering the request. The message names the request and is for the agent.
 */
export class UpstreamProtocolError extends UpstreamHttpError {
  constructor(message: string, status: number = PROTOCOL_FAILURE_STATUS) {
    super(message, status);
    this.name = 'UpstreamProtocolError';
  }
}

/** The provider's answer is larger than `maxBytes` : the rest was not read. */
export class UpstreamAnswerTooLarge extends UpstreamProtocolError {
  constructor(
    what: string,
    readonly maxBytes: number,
  ) {
    super(`${what}: the provider answered more than ${maxBytes} bytes; the answer was not read`);
    this.name = 'UpstreamAnswerTooLarge';
  }
}
