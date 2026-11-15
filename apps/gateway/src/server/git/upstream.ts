/**
 * The service side of the git remote, as the host drives it (spec §4.1 ter,
 * §2.4): the account's credential decrypted in memory, handed to the
 * plugin's `gitRemote.upstream`, presented to the service, released. The
 * agent's key never goes upstream; the service's credential never goes back.
 *
 * Also the relay stage of the git pipeline: the pipeline decides a fetch like
 * a tool call, and its upstream stage is where the bytes start to flow —
 * after the decision and the budget decrement, never before. The audit entry
 * is written when the relayed stream ends, so its latency covers the
 * transfer and a stream that broke is an upstream error.
 *
 * Bytes (spec §4.2 "Activity", Overview): a relayed fetch resolves with what
 * it sent and relayed (`RelayResult`), and the git pipeline's meter
 * (`gitMeter`) writes those on the entry; the push tool's pack is the door's
 * own count (`CallRequest.payload_bytes`).
 */
import {
  jsonMeter,
  UpstreamFailureError,
  type CallMeter,
  type CallRequest,
  type MissionAccount,
  type MissionContext,
  type UpstreamStage,
} from '@vaubaan/gateway-core';
import { isExecutorRefusal, refusalResult } from '@vaubaan/plugin-sdk';
import type { ExecuteContext, PluginRegistry, ServicePlugin } from '@vaubaan/plugin-sdk';
import type { GitAccess, GitRemoteCapability, GitUpstream } from '@vaubaan/plugin-sdk/git';

import type { CredentialBroker } from '../accounts';
import type { AccountCredentialCache } from '../execution';
import type { Logger } from '../logging';

/** The repository a git request is about, and who serves it. */
export interface GitTarget {
  readonly plugin: ServicePlugin;
  readonly remote: GitRemoteCapability;
  /** The mission's account to the plugin's service. */
  readonly account: MissionAccount;
  /** The resource ref (`owner/repo`). */
  readonly repository: string;
}

export interface UpstreamDeps {
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'contextOf'>;
  readonly credentialCache: AccountCredentialCache;
}

/** The context the plugin receives for one git request (memory only). */
export async function executeContextFor(
  deps: UpstreamDeps,
  ctx: MissionContext,
  target: GitTarget,
  /** The git request's: aborted at `git.request_timeout` or when git hangs up. */
  signal: AbortSignal,
): Promise<ExecuteContext> {
  const resolved = await deps.credentials.resolve(target.account.id);
  return {
    ...deps.credentials.contextOf(resolved, signal),
    resources: ctx.resources.filter((r) => r.account_id === target.account.id),
    credentialCache: deps.credentialCache.scopeFor(resolved.account),
  };
}

/** Request headers git sends that the service must see as they are. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'content-encoding',
  'git-protocol',
  'user-agent',
] as const;

/** Response headers of the service git must see. */
const FORWARDED_RESPONSE_HEADERS = ['content-type'] as const;

export interface UpstreamRequest {
  readonly method: 'GET' | 'POST';
  /** After the repository URL: `/info/refs?service=…`, `/git-upload-pack`. */
  readonly suffix: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly signal?: AbortSignal;
}

/** One request to the service's git endpoint, the body streamed as it comes. */
export async function callUpstream(
  ctx: ExecuteContext,
  upstream: GitUpstream,
  request: UpstreamRequest,
): Promise<Response> {
  const headers = new Headers({ Authorization: upstream.authorization });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
  return ctx.fetch(`${upstream.url}${request.suffix}`, init);
}

/** The service's answer as git receives it: its status, its type, its body untouched. */
export function relayedResponse(
  upstream: Response,
  body: ReadableStream<Uint8Array> | null,
): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache, no-store' });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(body, { status: upstream.status, headers });
}

/** What a relayed fetch resolves with: the bytes git sent up and the service's answer down. */
export interface RelayResult {
  readonly sent_bytes: number;
  readonly relayed_bytes: number;
}

function isRelayResult(value: unknown): value is RelayResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof RelayResult, unknown>>;
  return typeof v.sent_bytes === 'number' && typeof v.relayed_bytes === 'number';
}

/**
 * The git pipeline's meter: a relayed fetch counts what went through the
 * relay; the push tool, the pack the door read (`payload_bytes`) up and its
 * result down, like any tool.
 */
export const gitMeter: CallMeter = {
  measure(call, outcome) {
    if ('result' in outcome && isRelayResult(outcome.result)) {
      return {
        request_bytes: outcome.result.sent_bytes,
        response_bytes: outcome.result.relayed_bytes,
      };
    }
    return jsonMeter.measure(call, outcome);
  },
};

/** A stream that hands on `body` and counts what went through it. */
export function counted(body: ReadableStream<Uint8Array>): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly bytes: () => number;
} {
  let bytes = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, bytes: () => bytes };
}

/** The caller hung up while the service's answer was being relayed. */
export class GitCallerGoneError extends Error {
  constructor() {
    super('the git client went away; the relay was stopped.');
    this.name = 'GitCallerGoneError';
  }
}

/**
 * A stream that hands on `body` and tells when it ended: `done` resolves with
 * the byte count at the end, rejects when the service's stream broke or the
 * client went away.
 */
export function observed(body: ReadableStream<Uint8Array>): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly done: Promise<number>;
} {
  let bytes = 0;
  let settle!: { resolve: (n: number) => void; reject: (e: unknown) => void };
  const done = new Promise<number>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Read by the stage; never an unhandled rejection when nobody waits.
  done.catch(() => undefined);
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          controller.close();
          settle.resolve(bytes);
          return;
        }
        bytes += value.length;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        settle.reject(err);
      }
    },
    cancel(reason) {
      settle.reject(new GitCallerGoneError());
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return { stream, done };
}

// ─────────────────────────────────────────────────────────────────────────────
// The relay stage
// ─────────────────────────────────────────────────────────────────────────────

/** What the door gives the stage for one relayed fetch. */
export interface RelayJob {
  /** The resource ref the call names (`owner/repo`). */
  readonly repository: string;
  readonly access: GitAccess;
  readonly request: Omit<UpstreamRequest, 'signal'>;
  readonly signal: AbortSignal;
  /** Called once, with the response git receives, as soon as the service answered. */
  readonly respond: (response: Response) => void;
}

/**
 * The relay jobs of the calls in flight, by call. The pipeline hands its
 * upstream stage the very `CallRequest` the door built, so the job travels
 * with it without being an argument (it is not part of the fingerprint).
 */
export class RelayJobs {
  // single-process only — a job lives for one request in this process.
  private readonly jobs = new WeakMap<CallRequest, RelayJob>();

  attach(call: CallRequest, job: RelayJob): void {
    this.jobs.set(call, job);
  }

  of(call: CallRequest): RelayJob | undefined {
    return this.jobs.get(call);
  }
}

export interface GitUpstreamStageDeps extends UpstreamDeps {
  readonly registry: PluginRegistry;
  readonly jobs: RelayJobs;
  /** The execution door's upstream stage: `execute` of the push tool goes through it. */
  readonly plugins: UpstreamStage;
  readonly logger: Logger;
}

const HTTP_UNAUTHORIZED = 401;

/**
 * Upstream stage of the git pipeline: a relayed fetch for a call that carries
 * a relay job, the plugin's `execute` (the push tool) otherwise.
 */
export function createGitUpstreamStage(deps: GitUpstreamStageDeps): UpstreamStage {
  return {
    async execute(ctx, call, target) {
      const job = deps.jobs.of(call);
      if (!job) return deps.plugins.execute(ctx, call, target);
      const service = target.account.service;
      const plugin = deps.registry.get(service)?.plugin;
      const remote = plugin?.gitRemote;
      if (!plugin || !remote) throw new Error(`git relay: '${service}' declares no git remote`);
      const gitTarget: GitTarget = {
        plugin,
        remote,
        account: target.account,
        repository: job.repository,
      };
      const execCtx = await executeContextFor(deps, ctx, gitTarget, job.signal);
      let upstream: GitUpstream;
      try {
        upstream = await remote.upstream(execCtx, job.repository, job.access);
      } catch (err) {
        // The plugin declined (a permission the account lacks): a result, like any tool's.
        if (isExecutorRefusal(err)) return refusalResult(err.message);
        throw err;
      }
      const sent = job.request.body ? counted(job.request.body) : null;
      const answer = await callUpstream(execCtx, upstream, {
        ...job.request,
        body: sent?.stream ?? null,
        signal: job.signal,
      });
      if (!answer.ok || !answer.body) {
        await answer.body?.cancel();
        if (answer.status === HTTP_UNAUTHORIZED) {
          // A cached token the service no longer takes: the next request mints anew.
          await deps.credentialCache.drop(target.account.id);
        }
        throw new UpstreamFailureError({
          summary: `${service} git answered HTTP ${answer.status}`,
          detail: `${service} answered HTTP ${answer.status} to the fetch; try again, and tell the human if it persists`,
          status: answer.status,
        });
      }
      const { stream, done } = observed(answer.body);
      job.respond(relayedResponse(answer, stream));
      try {
        const relayed = await done;
        return { sent_bytes: sent?.bytes() ?? 0, relayed_bytes: relayed } satisfies RelayResult;
      } catch (err) {
        throw new UpstreamFailureError({
          summary:
            err instanceof GitCallerGoneError
              ? `${service} git stream stopped: the git client was gone`
              : `${service} git stream broke (${err instanceof Error ? err.name : 'Error'})`,
          detail: err instanceof Error ? err.message : String(err),
          status: null,
          cause: err,
        });
      }
    },
  };
}
