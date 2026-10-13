/**
 * `@vaubaan/telemetry` — community telemetry of the gateway (spec §9): the
 * frozen report, the batching queue and the client. Disabled unless the host
 * says otherwise. Handbook: docs/handbook/telemetry.md.
 */
export {
  createPluginReport,
  ERROR_CLASSES_BY_OUTCOME,
  httpErrorClass,
  isErrorClassOf,
  isPluginReport,
  isReportOutcome,
  PLUGIN_REPORT_KEYS,
  REPORT_FIELD_PATTERNS,
  REPORT_OUTCOMES,
  serializeReports,
  UNSTAMPED_GATEWAY_VERSION,
  type ErrorClass,
  type HttpErrorClass,
  type NamedErrorClass,
  type PluginReport,
  type PluginReportInput,
  type PluginReportKey,
  type ReportOutcome,
} from './report.ts';
export {
  backoffDelayMs,
  QUEUE_DEFAULTS,
  ReportQueue,
  type BackoffOptions,
  type QueueStats,
  type ReportBuffer,
  type ReportQueueOptions,
  type ScheduledTask,
  type SendResult,
} from './queue.ts';
export {
  COLLECTOR_KEY_PARAM,
  collectorEndpoint,
  collectorHeaders,
  DEFAULT_SEND_TIMEOUT_MS,
  isPlaceholderCollector,
  TELEMETRY_USER_AGENT,
  TelemetryClient,
  type CollectorEndpoint,
  type TelemetryClientOptions,
  type TelemetryClientState,
  type TelemetryLogger,
} from './client.ts';
