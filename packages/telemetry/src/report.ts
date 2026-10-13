/**
 * The community telemetry report (spec §9) — the whole of what an instance
 * may send to the collector about one `plugin.execute` outcome.
 *
 * FROZEN SHAPE. A report has exactly the six keys of `PLUGIN_REPORT_KEYS` and
 * nothing else: no arguments, no argument hash, no resource ref, no mission
 * or user identifier, no instance identifier, no network address, no
 * timestamp. Adding a key is a spec change (§9), not a refactor: the
 * structural test of the gateway and the collector's schema
 * (`deploy/collector/schema.sql`) both pin this list.
 *
 * Every value is drawn from a closed vocabulary or matches a narrow shape, so
 * no free text can travel in a report:
 *
 *   plugin, plugin_version   declared by the plugin (its id and semver)
 *   gateway_version          the build stamp of the image
 *   tool                     a tool name the plugin declares
 *   outcome                  one of `REPORT_OUTCOMES`
 *   error_class              `null` on success, otherwise one of the classes
 *                            allowed for the outcome (`ERROR_CLASSES_BY_OUTCOME`)
 *
 * `createPluginReport` is the only constructor: it returns `null` for anything
 * that does not fit, and the caller drops the report rather than sending a
 * value nobody vetted.
 */

export const PLUGIN_REPORT_KEYS = [
  'plugin',
  'plugin_version',
  'gateway_version',
  'tool',
  'outcome',
  'error_class',
] as const;
export type PluginReportKey = (typeof PLUGIN_REPORT_KEYS)[number];

export const REPORT_OUTCOMES = [
  'success',
  'upstream-error',
  'classification-error',
  'execution-error',
] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** The named error classes, per failing outcome. `upstream-error` also accepts `http_<status>`. */
export const ERROR_CLASSES_BY_OUTCOME = {
  'upstream-error': ['network', 'timeout', 'credential_rejected', 'unspecified'],
  'classification-error': ['executor_refused'],
  'execution-error': [
    'type_error',
    'range_error',
    'reference_error',
    'syntax_error',
    'non_error_throw',
  ],
} as const satisfies Record<Exclude<ReportOutcome, 'success'>, readonly string[]>;

export type NamedErrorClass =
  (typeof ERROR_CLASSES_BY_OUTCOME)[keyof typeof ERROR_CLASSES_BY_OUTCOME][number];
/** `http_<status>`: the HTTP status of the provider's answer, 100 to 599. */
export type HttpErrorClass = `http_${number}`;
export type ErrorClass = NamedErrorClass | HttpErrorClass;

export interface PluginReport {
  readonly plugin: string;
  readonly plugin_version: string;
  readonly gateway_version: string;
  readonly tool: string;
  readonly outcome: ReportOutcome;
  readonly error_class: ErrorClass | null;
}

/** Shapes shared with the collector's CHECK constraints (`deploy/collector/schema.sql`). */
export const REPORT_FIELD_PATTERNS = {
  plugin: /^[a-z][a-z0-9-]{0,62}$/,
  version: /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$/,
  tool: /^[a-z][a-z0-9_]{0,95}$/,
  httpErrorClass: /^http_[1-5][0-9]{2}$/,
} as const;

/** What an unstamped build (tests, `next dev`) reports as its version. */
export const UNSTAMPED_GATEWAY_VERSION = 'dev';

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/** `http_<status>` for a real HTTP status, `null` for anything else. */
export function httpErrorClass(status: number): HttpErrorClass | null {
  if (!Number.isInteger(status) || status < HTTP_STATUS_MIN || status > HTTP_STATUS_MAX) {
    return null;
  }
  return `http_${status}`;
}

export function isReportOutcome(value: unknown): value is ReportOutcome {
  return typeof value === 'string' && (REPORT_OUTCOMES as readonly string[]).includes(value);
}

/** True when `errorClass` is one the outcome allows (`null` exactly for `success`). */
export function isErrorClassOf(outcome: ReportOutcome, errorClass: unknown): boolean {
  if (outcome === 'success') return errorClass === null;
  if (typeof errorClass !== 'string') return false;
  if ((ERROR_CLASSES_BY_OUTCOME[outcome] as readonly string[]).includes(errorClass)) return true;
  return outcome === 'upstream-error' && REPORT_FIELD_PATTERNS.httpErrorClass.test(errorClass);
}

function isGatewayVersion(value: string): boolean {
  return value === UNSTAMPED_GATEWAY_VERSION || REPORT_FIELD_PATTERNS.version.test(value);
}

export interface PluginReportInput {
  readonly plugin: string;
  readonly plugin_version: string;
  readonly gateway_version: string;
  readonly tool: string;
  readonly outcome: ReportOutcome;
  readonly error_class: string | null;
}

/**
 * Builds a frozen report from vetted parts, or `null` when one of them does
 * not fit its shape. The result is a fresh object with exactly the six keys,
 * whatever else `input` carries.
 */
export function createPluginReport(input: PluginReportInput): PluginReport | null {
  if (typeof input.plugin !== 'string' || !REPORT_FIELD_PATTERNS.plugin.test(input.plugin)) {
    return null;
  }
  if (
    typeof input.plugin_version !== 'string' ||
    !REPORT_FIELD_PATTERNS.version.test(input.plugin_version)
  ) {
    return null;
  }
  if (typeof input.gateway_version !== 'string' || !isGatewayVersion(input.gateway_version)) {
    return null;
  }
  if (typeof input.tool !== 'string' || !REPORT_FIELD_PATTERNS.tool.test(input.tool)) return null;
  if (!isReportOutcome(input.outcome)) return null;
  if (!isErrorClassOf(input.outcome, input.error_class)) return null;
  return Object.freeze({
    plugin: input.plugin,
    plugin_version: input.plugin_version,
    gateway_version: input.gateway_version,
    tool: input.tool,
    outcome: input.outcome,
    error_class: input.error_class as ErrorClass | null,
  });
}

/** True for a value with exactly the six keys and a vetted value under each. */
export function isPluginReport(value: unknown): value is PluginReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== PLUGIN_REPORT_KEYS.length) return false;
  if (!PLUGIN_REPORT_KEYS.every((key) => keys.includes(key))) return false;
  return createPluginReport(value as PluginReportInput) !== null;
}

/**
 * The request body of a batch: a JSON array of reports. Each report is
 * rebuilt through `createPluginReport`, so a value that reached the queue by
 * a cast still leaves with the six vetted keys or not at all.
 */
export function serializeReports(reports: readonly PluginReport[]): string {
  return JSON.stringify(reports.flatMap((report) => createPluginReport(report) ?? []));
}
