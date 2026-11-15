/**
 * What an executor declines itself, as opposed to what its service failed.
 *
 * Handbook : docs/handbook/plugin-sdk.md, The contract.
 *
 * `execute` has three ways out, and the host reads them differently :
 *
 *   returns a result           the service answered ; the agent reads it
 *   returns `isError: true`    the executor DECLINED : a malformed argument,
 *                              a target outside the mission, a guard that
 *                              did not hold. Nothing failed at the service.
 *   throws                     the service failed (`UpstreamHttpError`,
 *                              `UpstreamAuthError`, a network error). The
 *                              host records `upstream_error`, counts it as a
 *                              failure of the plugin, and treats a 401 as a
 *                              rejected credential.
 *
 * A refusal thrown as a plain `Error` is read as the third : the audit says
 * the service failed when no request left, telemetry files a plugin fault,
 * and the agent gets an opaque "upstream error". `ExecutorRefusal` is the
 * typed way to decline from anywhere inside an executor ; `declining` turns
 * it into the `isError` result at the entry point and lets everything else
 * through untouched.
 */

import { brandError, hasErrorBrand, type McpToolResult } from '@vaubaan/shared';

/** The executor declines the call : thrown inside `execute`, never out of it. */
export class ExecutorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorRefusal';
    brandError(this, 'ExecutorRefusal');
  }
}

/** Whether `x` is an `ExecutorRefusal`, whatever copy of the SDK made it (the host asks this, never `instanceof`). */
export function isExecutorRefusal(x: unknown): x is ExecutorRefusal {
  return hasErrorBrand(x, 'ExecutorRefusal');
}

/** The `isError` result of a declined call : one text block, the reason. */
export function refusalResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs the body of an `execute`. An `ExecutorRefusal` thrown at any depth
 * becomes the `isError` result ; any other throw is the service's failure
 * and propagates for the host to record.
 */
export async function declining(run: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await run();
  } catch (error) {
    if (isExecutorRefusal(error)) return refusalResult(error.message);
    throw error;
  }
}
