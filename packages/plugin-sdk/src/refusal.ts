/**
 * What an executor declines itself, as opposed to what its provider failed.
 *
 * Handbook : docs/handbook/plugin-sdk.md, The contract.
 *
 * `execute` has three ways out, and the host reads them differently :
 *
 *   returns a result           the provider answered ; the agent reads it
 *   returns `isError: true`    the executor DECLINED : a malformed argument,
 *                              a target outside the mission, a guard that
 *                              did not hold. Nothing failed at the provider.
 *   throws                     the provider failed (`UpstreamHttpError`,
 *                              `UpstreamAuthError`, a network error). The
 *                              host records `upstream_error`, counts it as a
 *                              failure of the plugin, and treats a 401 as a
 *                              rejected credential.
 *
 * A refusal thrown as a plain `Error` is read as the third : the audit says
 * the provider failed when no request left, telemetry files a plugin fault,
 * and the agent gets an opaque "upstream error". `ExecutorRefusal` is the
 * typed way to decline from anywhere inside an executor ; `declining` turns
 * it into the `isError` result at the entry point and lets everything else
 * through untouched.
 */

import type { McpToolResult } from '@vaubaan/shared';

/** The executor declines the call : thrown inside `execute`, never out of it. */
export class ExecutorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorRefusal';
  }
}

/** The `isError` result of a declined call : one text block, the reason. */
export function refusalResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs the body of an `execute`. An `ExecutorRefusal` thrown at any depth
 * becomes the `isError` result ; any other throw is the provider's failure
 * and propagates for the host to record.
 */
export async function declining(run: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExecutorRefusal) return refusalResult(error.message);
    throw error;
  }
}
