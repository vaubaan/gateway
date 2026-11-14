/**
 * Upstream stage — decrypt the connection's credential in memory, forward the
 * call through the plugin, release (spec §2.4 "the executor never sees a
 * provider credential").
 *
 * The credential comes from the connections' `CredentialBroker` only
 * (handbook connections, Start here): `resolve()` decrypts
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
 * A deadline on every call (`execution.call_timeout_seconds`): the plugin
 * receives `ctx.signal`, aborted when the caller goes away or when the
 * deadline passes, and the stage stops waiting for it at that moment even
 * if the plugin does not listen. A call past its deadline is never retried;
 * it leaves as `UpstreamFailureError` whose summary ends in `(timeout)` —
 * the audit's `upstream_error` — and whose detail tells the agent the call
 * was counted and that its effect at the provider is unknown. A provider
 * that never answers therefore holds the request, the decrypted credential
 * and the audit entry for that long at most.
 *
 * Telemetry (spec §9): the final outcome of a call that reached
 * `plugin.execute` is handed, once, to the injected `TelemetrySink`
 * (`telemetry-sink.ts`; a no-op unless the composition root wires the
 * telemetry module). Two calls are not reported: one the broker stopped
 * before the plugin ran, and one whose caller went away (a streamed call
 * stopped by `CallerGoneError`, or any failure met after the call's signal
 * was aborted). Neither is an outcome of the plugin; the audit entry still
 * says what happened.
 */
import {
  type CallRequest,
  type CallTarget,
  type ConnectionStatus,
  isUnavailableConnectionStatus,
  isUpstreamFailureError,
  isUpstreamRefusalError,
  type MissionContext,
  refuse,
  upstreamErrorClassName,
  UpstreamFailureError,
  UpstreamRefusalError,
  type UpstreamStage,
} from '@vaubaan/gateway-core';
import type { ExecuteContext, McpToolResult, ToolResultPartSink } from '@vaubaan/plugin-sdk';
import { isUpstreamAuthError, type UpstreamAuthError } from '@vaubaan/shared';

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

/**
 * Who makes a call, as a host-composed `execute` receives it (never a plugin
 * loaded through the SDK): the calling mission, its creator — in whose name a
 * host-composed plugin acts — and the person holding the key, `null` for a
 * machine key.
 */
export interface HostCaller {
  readonly missionId: string;
  readonly userId: string;
  readonly holderUserId: string | null;
}

/**
 * An `execute` the host composed from its own services, run in place of the
 * plugin's declared one (ADR platform-management-is-a-plugin-on-the-execution-door):
 * the SDK's context plus the caller.
 */
export type HostComposedExecute = (
  ctx: ExecuteContext & { readonly caller: HostCaller },
  tool: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<McpToolResult>;

export interface UpstreamStageDeps {
  /**
   * The `execute` of each plugin the host composes itself, keyed by plugin id
   * (today `vaubaan`): run instead of `plugin.execute`, with the caller added.
   */
  readonly hostExecutes?: ReadonlyMap<string, HostComposedExecute>;
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'refresh' | 'contextOf'>;
  readonly credentialCache: ConnectionCredentialCache;
  readonly logger: Logger;
  /** Receives each `plugin.execute` outcome; default: a sink that does nothing. */
  readonly telemetry?: TelemetrySink;
  /** How long one call may wait for its plugin (`execution.call_timeout_seconds`), in seconds. */
  readonly callTimeoutSeconds: number;
}

const MS_PER_SECOND = 1000;

/** The provider said the credential itself is not valid (as opposed to "not allowed"). */
function credentialRejected(err: unknown): err is UpstreamAuthError {
  return isUpstreamAuthError(err) && err.upstreamStatus === HTTP_UNAUTHORIZED;
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
 * The HTTP status a failure carries: `UpstreamAuthError.upstreamStatus` or
 * `UpstreamHttpError.status` (the plugin contract), or the numeric `status`
 * HTTP clients put on their errors.
 */
function httpStatusOf(err: unknown): number | null {
  if (isUpstreamAuthError(err)) {
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
 * The call's deadline passed (`execution.call_timeout_seconds`) before the
 * plugin answered: what the stage rejects with, and what it records.
 */
export class CallTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`no answer within ${seconds} seconds`);
    this.name = 'CallTimeoutError';
  }
}

/**
 * What one call runs under: the signal the plugin receives (the caller's,
 * joined with the deadline) and the deadline alone, which tells a timeout
 * from a caller that left.
 */
interface CallLimits {
  readonly signal: AbortSignal;
  readonly deadline: AbortSignal;
  readonly seconds: number;
}

function limitsOf(call: CallRequest, seconds: number): CallLimits {
  const deadline = AbortSignal.timeout(seconds * MS_PER_SECOND);
  const signal = call.signal ? AbortSignal.any([call.signal, deadline]) : deadline;
  return { signal, deadline, seconds };
}

/** Why the call stopped when its signal was aborted: the deadline, or the caller. */
function stopReason(limits: CallLimits): Error {
  return limits.deadline.aborted ? new CallTimeoutError(limits.seconds) : new CallerGoneError();
}

/**
 * Settles with `promise`, or rejects as soon as the call's signal is aborted:
 * a plugin that ignores `ctx.signal` still releases the request at the deadline.
 */
function untilStopped<T>(promise: Promise<T>, limits: CallLimits): Promise<T> {
  const { signal } = limits;
  if (signal.aborted) return Promise.reject(stopReason(limits));
  let stop: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(stopReason(limits));
    signal.addEventListener('abort', stop, { once: true });
  });
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener('abort', stop));
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

function partRelayOf(call: CallRequest, limits: CallLimits): PartRelay {
  const relay: PartRelay = {
    count: 0,
    async emit(part) {
      // A stream that outlived its caller or its deadline stops at its next part.
      if (limits.signal.aborted) throw stopReason(limits);
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
  if (isUpstreamFailureError(err)) return err;
  const status = httpStatusOf(err);
  const className = upstreamErrorClassName(err);
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof CallTimeoutError) {
    const after = parts > 0 ? ` after ${partsPhrase(parts)}` : '';
    return new UpstreamFailureError({
      summary: `${provider} call stopped${after}: no answer within ${err.seconds} s (timeout)`,
      detail:
        `timeout: ${provider} did not answer within ${err.seconds} seconds, so Vaubaan stopped the call` +
        `${after} (execution.call_timeout_seconds). It was counted against the mission; whether ` +
        `${provider} carried it out is unknown: check before repeating a change.`,
      status: null,
      cause: err,
    });
  }
  if (err instanceof CallerGoneError) {
    return new UpstreamFailureError({
      summary:
        parts > 0
          ? `${provider} stream stopped after ${partsPhrase(parts)}: the caller was gone`
          : `${provider} call stopped: the caller was gone`,
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
  /** The plugin each call reached, if any, and when: what `report` reads once the call has ended. */
  const reached = new WeakMap<
    CallRequest,
    { readonly plugin: ResolvedCredential['plugin']; readonly startedAt: number }
  >();

  /** The one telemetry hook. A sink never fails a call. */
  function report(call: CallRequest, outcome: PluginOutcome): void {
    const entry = reached.get(call);
    if (!entry) return;
    try {
      const durationMs = performance.now() - entry.startedAt;
      telemetry.pluginExecuted({ plugin: entry.plugin, tool: call.tool, outcome, durationMs });
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
    limits: CallLimits,
  ) {
    // The first attempt starts the clock; a retry keeps it.
    const startedAt = reached.get(call)?.startedAt ?? performance.now();
    reached.set(call, { plugin: resolved.plugin, startedAt });
    const context: ExecuteContext = {
      ...deps.credentials.contextOf(resolved, limits.signal),
      resources: ctx.resources.filter((r) => r.connection_id === target.connection.id),
      agentLabel: call.agent_label,
      credentialCache: deps.credentialCache.scopeFor(resolved.connection),
      emitPart: relay.emit,
    };
    const hostExecute = deps.hostExecutes?.get(resolved.plugin.id);
    const { holder } = ctx.token;
    const answer = hostExecute
      ? hostExecute(
          {
            ...context,
            caller: {
              missionId: ctx.mission.id,
              userId: ctx.mission.creator_id,
              holderUserId: holder.kind === 'member' ? holder.user_id : null,
            },
          },
          call.tool,
          call.args,
        )
      : resolved.plugin.execute(context, call.tool, call.args);
    return untilStopped(answer, limits);
  }

  /** Maps a broker failure to the refusal the agent reads, or returns the error untouched. */
  async function asUnavailable(err: unknown, target: CallTarget): Promise<unknown> {
    const { connection } = target;
    let status: ConnectionStatus | 'missing' | null = null;
    if (err instanceof ConnectionUnavailableError) status = err.connectionStatus;
    // A rejected refresh: the broker marked the connection `expired` before throwing.
    else if (isUpstreamAuthError(err)) status = 'expired';
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
    limits: CallLimits,
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
    // A call past its deadline, or whose caller left, is not replayed either.
    const retriable = (err: unknown): boolean =>
      credentialRejected(err) && relay.count === 0 && !limits.signal.aborted;

    try {
      return await forward(resolved, ctx, call, target, relay, limits);
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
        return await forward(resolved, ctx, call, target, relay, limits);
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
    return forward(refreshed, ctx, call, target, relay, limits);
  }

  return {
    async execute(ctx, call, target): Promise<unknown> {
      const limits = limitsOf(call, deps.callTimeoutSeconds);
      const relay = partRelayOf(call, limits);
      try {
        const result = await attempt(ctx, call, target, relay, limits);
        report(call, { ok: true, result });
        return result;
      } catch (thrown) {
        if (isUpstreamRefusalError(thrown)) {
          if (!call.signal?.aborted) report(call, { ok: false, error: thrown });
          throw thrown;
        }
        // Whatever the plugin threw once its signal fired (an AbortError of its fetch)
        // is the deadline's or the caller's doing: recorded as such.
        const err = limits.signal.aborted ? stopReason(limits) : thrown;
        // The caller left: not an outcome of the plugin, nothing to report (spec §9).
        if (!(err instanceof CallerGoneError)) report(call, { ok: false, error: err });
        throw asUpstreamFailure(err, target.connection.provider, relay.count);
      }
    },
  };
}
