/**
 * Upstream stage — decrypt the connection's credential in memory, forward the
 * call through the plugin, release (spec §2.4 "the executor never sees a
 * provider credential").
 *
 * The credential comes from the connections' `CredentialBroker` only
 * (handbook connections, "Credentials and refresh"): `resolve()` decrypts
 * and refreshes an OAuth token about to expire; `refresh()` forces a refresh
 * and marks the connection `expired` when the provider rejects it. This
 * module never reads a sealed blob.
 *
 * When the provider answers that the credential is not valid (HTTP 401,
 * surfaced by the plugin as `UpstreamAuthError`):
 *
 *   1. the derived credentials cached for the connection are dropped; if
 *      there were any, the call is retried once with the same stored
 *      credential (the rejected one may have been a cached installation
 *      token, not the connection's credential);
 *   2. otherwise, or if that retry is rejected too, the broker refreshes and
 *      the call is retried once;
 *   3. a rejected refresh (the broker has then marked the connection
 *      `expired`), or a connection that is no longer `active`, ends as the
 *      `connection-unavailable` refusal, thrown as `UpstreamRefusalError`.
 *
 * A 403 is NOT treated as a dead credential: the provider recognised the
 * credential and refused that action (a permission the company's app lacks, a
 * secondary rate limit). Expiring the connection on it would stop every
 * mission of that connection for a call that was merely not permitted; it is
 * reported as an ordinary upstream failure, naming the provider's answer.
 *
 * Every failure that is not that refusal leaves as `UpstreamFailureError`.
 * Plugins build their message from the request path and the start of the
 * provider's body, and providers echo input there (a SQL fragment, an object
 * id). So the message is the `detail`, for the agent only; what the audit
 * keeps is the `summary` built here from the provider id, the HTTP status
 * when the error carries one, and the error's class name.
 *
 * Streaming (spec §4.1): the plugin receives `emitPart`. Each part it emits
 * is counted and handed to the call's `onPart` (the door turns it into a
 * progress notification) while `execute` keeps reading the provider; the
 * stage still resolves with the complete result, so the pipeline writes the
 * audit entry when the stream has ended. After a first part the retry ladder
 * is closed, and a failure is summarised as `<provider> stream failed after
 * N parts (…)`. `emitPart` rejects with `CallerGoneError` once the call's
 * signal is aborted: the plugin stops, the entry records `stream stopped
 * after N parts: the caller was gone`. The credit stays consumed in every
 * case (ADR atomic-budget-accounting).
 *
 * Telemetry (spec §9): the final outcome of a call that reached
 * `plugin.execute` is handed, once, to the injected `TelemetrySink`
 * (`telemetry-sink.ts`; a no-op unless the composition root wires the
 * telemetry module). A call the broker stopped before the plugin ran is not
 * a plugin outcome and is not reported.
 */
import {
  isUnavailableConnectionStatus,
  refuse,
  UpstreamFailureError,
  upstreamErrorClassName,
  UpstreamRefusalError,
  type CallRequest,
  type CallTarget,
  type ConnectionStatus,
  type MissionContext,
  type UpstreamStage,
} from '@vaubaan/gateway-core';
import type { ToolResultPartSink } from '@vaubaan/plugin-sdk';
import { UpstreamAuthError } from '@vaubaan/shared';

import {
  ConnectionUnavailableError,
  type CredentialBroker,
  type ResolvedCredential,
} from '../connections';
import type { Logger } from '../logging';
import type { ConnectionCredentialCache } from './credential-cache';
import { NOOP_TELEMETRY_SINK, type PluginOutcome, type TelemetrySink } from './telemetry-sink';

const HTTP_UNAUTHORIZED = 401;
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

export interface UpstreamStageDeps {
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'refresh' | 'contextOf'>;
  readonly credentialCache: ConnectionCredentialCache;
  readonly logger: Logger;
  /** Receives each `plugin.execute` outcome; default: a sink that does nothing. */
  readonly telemetry?: TelemetrySink;
}

/** The provider said the credential itself is not valid (as opposed to "not allowed"). */
function credentialRejected(err: unknown): err is UpstreamAuthError {
  return err instanceof UpstreamAuthError && err.upstreamStatus === HTTP_UNAUTHORIZED;
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= HTTP_STATUS_MIN &&
    value <= HTTP_STATUS_MAX
  );
}

/**
 * The HTTP status a failure carries: `UpstreamAuthError.upstreamStatus` (the
 * plugin contract), or the numeric `status` HTTP clients put on their errors.
 */
function httpStatusOf(err: unknown): number | null {
  if (err instanceof UpstreamAuthError) {
    return isHttpStatus(err.upstreamStatus) ? err.upstreamStatus : null;
  }
  if (typeof err !== 'object' || err === null || !('status' in err)) return null;
  return isHttpStatus(err.status) ? err.status : null;
}

/**
 * The caller of a streamed call went away (disconnect, MCP cancellation):
 * what `emitPart` rejects with, so the plugin stops reading its provider.
 */
export class CallerGoneError extends Error {
  constructor() {
    super('the caller is gone; the stream was stopped.');
    this.name = 'CallerGoneError';
  }
}

/**
 * The parts of one call's result, relayed to the caller as the plugin emits
 * them (`ExecuteContext.emitPart`), and counted: the count is what tells a
 * stream that broke midway from a call that failed before delivering
 * anything.
 */
interface PartRelay {
  /** Parts emitted so far. */
  count: number;
  readonly emit: ToolResultPartSink;
}

function partRelayOf(call: CallRequest): PartRelay {
  const relay: PartRelay = {
    count: 0,
    async emit(part) {
      // Read between two parts only: a provider call in flight is never interrupted.
      if (call.signal?.aborted) throw new CallerGoneError();
      relay.count += 1;
      await call.onPart?.(part);
    },
  };
  return relay;
}

function partsPhrase(count: number): string {
  return `${count} ${count === 1 ? 'part' : 'parts'}`;
}

/** A provider failure, split into what the audit stores and what the agent reads. */
function asUpstreamFailure(err: unknown, provider: string, parts: number): UpstreamFailureError {
  if (err instanceof UpstreamFailureError) return err;
  const status = httpStatusOf(err);
  const className = upstreamErrorClassName(err);
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof CallerGoneError) {
    return new UpstreamFailureError({
      summary: `${provider} stream stopped after ${partsPhrase(parts)}: the caller was gone`,
      detail,
      status: null,
      cause: err,
    });
  }
  if (parts > 0) {
    // The caller already holds what was sent; the audit says where it stopped.
    const answered = status === null ? '' : `, HTTP ${status}`;
    return new UpstreamFailureError({
      summary: `${provider} stream failed after ${partsPhrase(parts)}${answered} (${className})`,
      detail: `the stream was interrupted after ${partsPhrase(parts)}: ${detail}`,
      status,
      cause: err,
    });
  }
  return new UpstreamFailureError({
    summary:
      status === null
        ? `${provider} call failed (${className})`
        : `${provider} answered HTTP ${status} (${className})`,
    detail,
    status,
    cause: err,
  });
}

export function createUpstreamStage(deps: UpstreamStageDeps): UpstreamStage {
  const telemetry = deps.telemetry ?? NOOP_TELEMETRY_SINK;
  /** The plugin each call reached, if any: what `report` reads once the call has ended. */
  const reached = new WeakMap<CallRequest, ResolvedCredential['plugin']>();

  /** The one telemetry hook. A sink never fails a call. */
  function report(call: CallRequest, outcome: PluginOutcome): void {
    const plugin = reached.get(call);
    if (!plugin) return;
    try {
      telemetry.pluginExecuted({ plugin, tool: call.tool, outcome });
    } catch (err) {
      deps.logger.warn('telemetry sink failed', { error: upstreamErrorClassName(err) });
    }
  }

  function forward(
    resolved: ResolvedCredential,
    ctx: MissionContext,
    call: CallRequest,
    target: CallTarget,
    relay: PartRelay,
  ) {
    reached.set(call, resolved.plugin);
    return resolved.plugin.execute(
      {
        ...deps.credentials.contextOf(resolved),
        resources: ctx.resources.filter((r) => r.connection_id === target.connection.id),
        agentLabel: call.agent_label,
        credentialCache: deps.credentialCache.scopeFor(resolved.connection),
        emitPart: relay.emit,
      },
      call.tool,
      call.args,
    );
  }

  /** Maps a broker failure to the refusal the agent reads, or returns the error untouched. */
  async function asUnavailable(err: unknown, target: CallTarget): Promise<unknown> {
    const { connection } = target;
    let status: ConnectionStatus | 'missing' | null = null;
    if (err instanceof ConnectionUnavailableError) status = err.connectionStatus;
    // A rejected refresh: the broker marked the connection `expired` before throwing.
    else if (err instanceof UpstreamAuthError) status = 'expired';
    if (status === null || status === 'missing' || !isUnavailableConnectionStatus(status)) {
      return err;
    }
    await deps.credentialCache.drop(connection.id);
    return new UpstreamRefusalError(
      refuse.connectionUnavailable({
        connection: { id: connection.id, name: connection.display_name },
        status,
        owner: connection.owner,
      }),
      err instanceof Error ? err.message : undefined,
    );
  }

  /** Resolve, forward, and climb the retry ladder of the header. */
  async function attempt(
    ctx: MissionContext,
    call: CallRequest,
    target: CallTarget,
    relay: PartRelay,
  ): Promise<unknown> {
    const connectionId = target.connection.id;
    let resolved: ResolvedCredential;
    try {
      resolved = await deps.credentials.resolve(connectionId);
    } catch (err) {
      throw await asUnavailable(err, target);
    }
    // Once a part has left for the caller the call is never replayed: a retry
    // would deliver the beginning of the result twice.
    const retriable = (err: unknown): boolean => credentialRejected(err) && relay.count === 0;

    try {
      return await forward(resolved, ctx, call, target, relay);
    } catch (err) {
      if (!retriable(err)) throw err;
      deps.logger.warn('upstream rejected the credential', {
        connection_id: connectionId,
        provider: target.connection.provider,
        tool: call.tool,
      });
    }

    if ((await deps.credentialCache.drop(connectionId)) > 0) {
      try {
        return await forward(resolved, ctx, call, target, relay);
      } catch (err) {
        if (!retriable(err)) throw err;
      }
    }

    let refreshed: ResolvedCredential;
    try {
      refreshed = await deps.credentials.refresh(connectionId);
    } catch (err) {
      throw await asUnavailable(err, target);
    }
    // A second rejection right after a successful refresh is final for this call;
    // the next call starts over and the broker decides the connection's fate.
    return forward(refreshed, ctx, call, target, relay);
  }

  return {
    async execute(ctx, call, target): Promise<unknown> {
      const relay = partRelayOf(call);
      try {
        const result = await attempt(ctx, call, target, relay);
        report(call, { ok: true, result });
        return result;
      } catch (err) {
        report(call, { ok: false, error: err });
        if (err instanceof UpstreamRefusalError) throw err;
        throw asUpstreamFailure(err, target.connection.provider, relay.count);
      }
    },
  };
}
