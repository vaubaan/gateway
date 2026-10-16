/**
 * Telemetry client: the only code path by which a report leaves an instance.
 *
 * Three gates stand before the network, checked when a report is recorded
 * AND again when a batch is about to be sent:
 *
 *   1. `isEnabled()` is false (the default)          → nothing is queued, nothing is sent
 *   2. the collector URL is the placeholder default  → nothing is queued, nothing is sent;
 *      (no collector exists behind it yet)             one warning, once per process
 *   3. otherwise                                     → queued, sent in batches
 *
 * Switching telemetry off empties the queue: a report recorded while it was
 * on never leaves after the operator turned it off.
 *
 * The request: `POST <collector URL>` with the batch of `wire.ts`
 * (`serializeBatch`), `Prefer: return=minimal` (the collector is insert-only
 * and grants no read-back). When the configured URL carries an `apikey` query
 * parameter — the collector's public, anonymous key — the client moves it to
 * the `apikey` and `Authorization` headers and removes it from the URL, so the
 * key is not written to access logs as part of a path. No cookie, no
 * referrer, redirects refused: a collector that answers with a redirect could
 * otherwise move reports to a host the operator never configured.
 *
 * Nothing but the batch is sent: no instance identifier, no hostname, no
 * version header (the versions are in the reports).
 */
import { ReportQueue, type QueueStats, type ReportQueueOptions, type SendResult } from './queue.ts';
import { serializeBatch, type TelemetryReport } from './wire.ts';

/** The query parameter carrying the collector's public key in the configured URL. */
export const COLLECTOR_KEY_PARAM = 'apikey';
export const TELEMETRY_USER_AGENT = 'vaubaan-gateway-telemetry';
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_SERVER_ERROR_MIN = 500;

export interface TelemetryLogger {
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  debug(message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface TelemetryClientOptions {
  /** Read on every report and before every send. */
  readonly isEnabled: () => boolean;
  /** The collector URL in use (instance configuration). */
  readonly collectorUrl: URL;
  /** The placeholder default: while the URL in use points at it (same origin and path), nothing is sent. */
  readonly placeholderUrl: URL;
  readonly fetch: typeof fetch;
  readonly logger: TelemetryLogger;
  readonly sendTimeoutMs?: number;
  readonly queue?: Omit<ReportQueueOptions, 'send'>;
}

/** Why the client is, or is not, sending. */
export type TelemetryClientState = 'disabled' | 'placeholder-collector' | 'sending';

export interface CollectorEndpoint {
  /** The URL requests go to: the configured one without its key parameter. */
  readonly url: URL;
  /** The collector's public key, when the configured URL carried one. */
  readonly key: string | null;
}

/** Splits the configured collector URL into the request URL and the public key. */
export function collectorEndpoint(configured: URL): CollectorEndpoint {
  const url = new URL(configured.href);
  const key = url.searchParams.get(COLLECTOR_KEY_PARAM);
  url.searchParams.delete(COLLECTOR_KEY_PARAM);
  return { url, key: key && key.length > 0 ? key : null };
}

/** The headers of every request to the collector (reports and statistics). */
export function collectorHeaders(key: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': TELEMETRY_USER_AGENT };
  if (key !== null) {
    headers.apikey = key;
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Where a URL points, whatever it carries: origin and path, trailing slashes dropped. */
function locationOf(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * True while the collector URL in use points at the placeholder default (no
 * collector behind it). Compared by origin and path, never by the full text:
 * the default with a key or any other query appended, a fragment, or a
 * trailing slash is still the placeholder, and nothing is sent to it.
 */
export function isPlaceholderCollector(collectorUrl: URL, placeholderUrl: URL): boolean {
  return locationOf(collectorUrl) === locationOf(placeholderUrl);
}

export class TelemetryClient {
  private readonly queue: ReportQueue;
  private readonly endpoint: CollectorEndpoint;
  private readonly placeholder: boolean;
  private readonly sendTimeoutMs: number;
  // single-process only: "once per process" log latches. Per-process by nature (each
  // process warns once); nothing to share, so no interface replaces them.
  private placeholderLogged = false;
  private rejectionLogged = false;

  constructor(private readonly options: TelemetryClientOptions) {
    this.endpoint = collectorEndpoint(options.collectorUrl);
    this.placeholder = isPlaceholderCollector(options.collectorUrl, options.placeholderUrl);
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.queue = new ReportQueue({ ...options.queue, send: (batch) => this.send(batch) });
  }

  get state(): TelemetryClientState {
    if (!this.options.isEnabled()) return 'disabled';
    return this.placeholder ? 'placeholder-collector' : 'sending';
  }

  get stats(): QueueStats {
    return this.queue.stats;
  }

  /** Queues a report when telemetry is on and a real collector is configured. Never throws. */
  record(report: TelemetryReport): void {
    if (!this.gateOpen()) return;
    this.queue.push(report);
  }

  /** Sends one batch now. For tests and shutdown paths. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** The operator switched telemetry off: what is queued must not leave. */
  discardQueued(): void {
    this.queue.clear();
  }

  stop(): void {
    this.queue.stop();
  }

  /** The gates of the header; empties the queue when one is closed. */
  private gateOpen(): boolean {
    const state = this.state;
    if (state === 'sending') return true;
    if (state === 'placeholder-collector' && !this.placeholderLogged) {
      this.placeholderLogged = true;
      this.options.logger.warn(
        'telemetry is enabled but the collector URL is still the placeholder default: ' +
          'nothing is sent. Set telemetry.collector_url to a real collector to contribute reports.',
      );
    }
    if (this.queue.stats.queued > 0) this.queue.clear();
    return false;
  }

  private async send(batch: readonly TelemetryReport[]): Promise<SendResult> {
    // Telemetry may have been switched off since the batch was queued.
    if (!this.gateOpen()) return 'rejected';
    let response: Response;
    try {
      response = await this.options.fetch(this.endpoint.url, {
        method: 'POST',
        headers: {
          ...collectorHeaders(this.endpoint.key),
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body: serializeBatch(batch),
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(this.sendTimeoutMs),
      });
    } catch {
      // Unreachable collector, timeout, refused redirect: try again later.
      this.options.logger.debug('telemetry: the collector could not be reached');
      return 'retry';
    }
    // The body is never read: the collector has nothing to tell an instance.
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return 'delivered';
    const { status } = response;
    if (
      status === HTTP_TOO_MANY_REQUESTS ||
      status === HTTP_REQUEST_TIMEOUT ||
      status >= HTTP_SERVER_ERROR_MIN
    ) {
      return 'retry';
    }
    if (!this.rejectionLogged) {
      this.rejectionLogged = true;
      this.options.logger.warn('telemetry: the collector refused a batch; it was dropped', {
        status,
      });
    }
    return 'rejected';
  }
}
