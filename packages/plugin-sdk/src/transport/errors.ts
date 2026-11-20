/**
 * The two failures a service can cause besides a failed status : an answer
 * the protocol does not allow, and an answer larger than the plugin reads.
 *
 * Both are an `UpstreamHttpError` (status 502, "bad gateway") : the host
 * records them as the service's failure (`upstream_error`, "the service
 * answered HTTP 502"), the agent reads the message, and telemetry never
 * files them as a fault of the plugin — which a plain `Error` would be
 * (`refusal.ts`).
 */

import { brandError, hasErrorBrand, isUpstreamHttpError, UpstreamHttpError } from '@vaubaan/shared';

/** The status a protocol failure carries : the service is a bad gateway for the call. */
export const PROTOCOL_FAILURE_STATUS = 502;

/**
 * The service answered, but not what its protocol says : a JSON-RPC error
 * frame, a body that is not JSON, a document of the wrong shape, no frame
 * answering the request. The message names the request and is for the agent.
 */
export class UpstreamProtocolError extends UpstreamHttpError {
  constructor(message: string, status: number = PROTOCOL_FAILURE_STATUS) {
    super(message, status);
    this.name = 'UpstreamProtocolError';
    brandError(this, 'UpstreamProtocolError');
  }
}

/**
 * Whether `x` is an `UpstreamProtocolError` (an `UpstreamAnswerTooLarge`
 * included), whatever copy of the SDK made it : the host asks this, never
 * `instanceof` (ADR plugins-bundled-or-pinned-by-the-operator).
 */
export function isUpstreamProtocolError(x: unknown): x is UpstreamProtocolError {
  return hasErrorBrand(x, 'UpstreamProtocolError') && isUpstreamHttpError(x);
}

/** The service's answer is larger than `maxBytes` : the rest was not read. */
export class UpstreamAnswerTooLarge extends UpstreamProtocolError {
  constructor(
    what: string,
    readonly maxBytes: number,
  ) {
    super(`${what}: the service answered more than ${maxBytes} bytes; the answer was not read`);
    this.name = 'UpstreamAnswerTooLarge';
  }
}

/**
 * The upstream MCP server does not know the tool the plugin called : its
 * `tools/call` answered "tool not found" (JSON-RPC `-32602`, or `-32601`).
 * The plugin's frozen tool list is behind the service, and the message says
 * so, for the agent and for the person who updates the plugin. Still an
 * `UpstreamProtocolError` : the host records the service's failure.
 */
export class UpstreamToolMissing extends UpstreamProtocolError {
  constructor(
    server: string,
    readonly tool: string,
    serviceText: string,
  ) {
    super(
      `${server} no longer exposes the tool '${tool}' (${serviceText}) : this plugin's tool list ` +
        `is behind the service. Update the plugin ; until then, another tool of the plugin may serve.`,
    );
    this.name = 'UpstreamToolMissing';
  }
}
