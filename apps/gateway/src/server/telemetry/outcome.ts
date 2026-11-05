/**
 * From a `plugin.execute` outcome to a telemetry report (spec §9).
 *
 * The outcome carries the provider's result or the thrown error; both can
 * echo the call's arguments, a resource ref, a token. This module is the
 * reduction to the closed vocabulary of `@vaubaan/telemetry`: it never copies
 * a string out of a result or an error. It reads only
 *
 *   - whether a result has `isError: true`;
 *   - the JavaScript class of a thrown value (`instanceof`, never its `name`);
 *   - a numeric HTTP status (`UpstreamAuthError.upstreamStatus`, or a numeric
 *     `status` such as `UpstreamHttpError.status`), kept only when it is an
 *     integer from 100 to 599;
 *   - an error `code` or `name`, compared for equality with the fixed lists
 *     below and then discarded.
 *
 * Outcome classes, as seen from the upstream stage:
 *
 *   success               the plugin returned a result that is not an error
 *   classification-error  the plugin returned `isError: true`: its executor
 *                         declined a call its own classifier had let through
 *                         (unknown tool, a target or an argument the executor
 *                         rejects, a tool that is not implemented)
 *                         → `executor_refused`. A provider failure is never
 *                         returned this way: plugins throw it (handbook
 *                         plugin-sdk, The contract)
 *   upstream-error        the provider, or the way to it, failed
 *                         → `http_<status>`, `network`, `timeout`,
 *                           `credential_rejected` (the connection's credential
 *                           was refused and could not be refreshed),
 *                           `unspecified` (an error with no status)
 *
 * A call whose caller went away is never handed to this module (the upstream
 * stage does not report it): a disconnect is not an outcome of the plugin.
 *   execution-error       the plugin's code failed
 *                         → `type_error`, `range_error`, `reference_error`,
 *                           `syntax_error`, `non_error_throw`
 *
 * The plugin id, its version and the tool come from the plugin's own
 * declaration; a tool name the plugin does not declare yields no report, so
 * a name chosen by an agent never travels.
 */
import { isUpstreamRefusalError } from '@vaubaan/gateway-core';
import { isUpstreamAuthError } from '@vaubaan/shared';
import {
  createPluginReport,
  durationBucket,
  httpErrorClass,
  type ErrorClass,
  type PluginReport,
  type ReportOutcome,
} from '@vaubaan/telemetry';

import type { PluginExecution, PluginOutcome } from '../execution/telemetry-sink';

interface Classified {
  readonly outcome: ReportOutcome;
  readonly error_class: ErrorClass | null;
}

/** `code` values of Node and undici that mean the provider could not be reached. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);
/** `code` and `name` values that mean the call ran out of time. */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);
/** The message `fetch` gives every network failure; compared, never copied. */
const FETCH_FAILED = 'fetch failed';
/** How deep the `cause` chain is followed. */
const MAX_CAUSE_DEPTH = 3;

function upstream(errorClass: ErrorClass): Classified {
  return { outcome: 'upstream-error', error_class: errorClass };
}

function execution(errorClass: ErrorClass): Classified {
  return { outcome: 'execution-error', error_class: errorClass };
}

function ownString(value: object, key: 'code' | 'name'): string | null {
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : null;
}

/** `network`, `timeout` or `null`, from the error and the errors it wraps. */
function transportClass(thrown: unknown): 'network' | 'timeout' | null {
  let current: unknown = thrown;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const code = ownString(current, 'code');
    const name = ownString(current, 'name');
    if ((code !== null && TIMEOUT_CODES.has(code)) || (name !== null && TIMEOUT_NAMES.has(name))) {
      return 'timeout';
    }
    if (code !== null && NETWORK_CODES.has(code)) return 'network';
    if (current instanceof TypeError && current.message === FETCH_FAILED) {
      // The cause may still name a timeout; a bare `fetch failed` is the network.
      return transportClass((current as { cause?: unknown }).cause) ?? 'network';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The HTTP status a thrown value carries, as `http_<status>`, or `null`. */
function statusClass(thrown: object): ErrorClass | null {
  if (isUpstreamAuthError(thrown)) return httpErrorClass(thrown.upstreamStatus);
  const status = (thrown as { status?: unknown }).status;
  return typeof status === 'number' ? httpErrorClass(status) : null;
}

function classifyThrown(thrown: unknown): Classified {
  if (typeof thrown !== 'object' || thrown === null) return execution('non_error_throw');
  // The connection's credential was refused for good (or the connection was
  // revoked meanwhile): the plugin ran, the provider said no.
  if (isUpstreamRefusalError(thrown)) return upstream('credential_rejected');
  const status = statusClass(thrown);
  if (status !== null) return upstream(status);
  const transport = transportClass(thrown);
  if (transport !== null) return upstream(transport);
  if (thrown instanceof TypeError) return execution('type_error');
  if (thrown instanceof RangeError) return execution('range_error');
  if (thrown instanceof ReferenceError) return execution('reference_error');
  if (thrown instanceof SyntaxError) return execution('syntax_error');
  if (!(thrown instanceof Error)) return execution('non_error_throw');
  // A provider failure that carries no status (a JSON-RPC error frame, an
  // unusable answer): plugins throw a plain `Error` for it.
  return upstream('unspecified');
}

function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result
    ? result.isError === true
    : false;
}

/** The outcome class and error class of one `plugin.execute` outcome. */
export function classifyOutcome(outcome: PluginOutcome): Classified {
  if (!outcome.ok) return classifyThrown(outcome.error);
  if (isErrorResult(outcome.result)) {
    return { outcome: 'classification-error', error_class: 'executor_refused' };
  }
  return { outcome: 'success', error_class: null };
}

/**
 * The report of one execution, or `null` when it must not be reported: the
 * tool is not one the plugin declares, or a declared value does not fit the
 * report's shapes.
 */
export function reportOf(execution: PluginExecution, gatewayVersion: string): PluginReport | null {
  const { plugin, tool } = execution;
  if (!plugin.tools.some((declared) => declared.name === tool)) return null;
  return createPluginReport({
    plugin: plugin.id,
    plugin_version: plugin.version,
    gateway_version: gatewayVersion,
    tool,
    ...classifyOutcome(execution.outcome),
    duration_bucket: durationBucket(execution.durationMs),
  });
}
