/**
 * A push through the git remote (spec §4.1 bis; ADR gateway-as-git-remote D4–D6).
 *
 *   1. read    the command list, bounded; the pack stays in the stream
 *   2. precheck with the updates as git sent them (fast-forward assumed, no
 *              files): a push the mission can never make is refused, and
 *              audited, before any byte leaves for the provider
 *   3. store   the pack at the provider under temporary refs
 *              (`refs/vaubaan/<mission>/<nonce>/<n>`), streamed through a byte
 *              counter that cuts it at `git.max_pack_mb`
 *   4. review  each update at the provider (`gitRemote.review`): fast-forward
 *              or not, commits, changed paths, workflow files
 *   5. decide  one call, the reviewed updates as arguments: one decision, one
 *              request when gated, one audit entry, every ref refused when one is
 *   6. move    allowed: the plugin's `execute` moves the real refs, the
 *              reviewed old ids as compare-and-swap values
 *   7. clean   the temporary refs are deleted — except when the push waits for
 *              an approval: they stay until the request expires (sweeper)
 *
 * Every refusal reaches git as `ng <ref> <reason>` on each ref of the push,
 * and the instruction (with the URL to hand to a human) on `remote:` lines.
 */
import { randomBytes } from 'node:crypto';

import {
  type CallOutcome,
  type CallPipeline,
  type CallRequest,
  type ClientOrigin,
  type MissionContext,
  type Refusal,
} from '@vaubaan/gateway-core';
import {
  concatBytes,
  encodeCommandList,
  ExecutorRefusal,
  GIT_TEMPORARY_REF_PREFIX,
  GitProtocolError,
  parseReceivePackResult,
  PktLineError,
  PktLineReader,
  pktLine,
  readCommandList,
  RECEIVE_PACK_REQUEST_TYPE,
  RECEIVE_PACK_RESULT_TYPE,
  RECEIVE_PACK_SERVICE,
  sendRefUpdates,
  type CommandList,
  type ExecuteContext,
  type GitPushResult,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpstream,
  type RefCommand,
} from '@vaubaan/plugin-sdk';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { PendingRefsRepo } from '../store';
import { callUpstream, executeContextFor, type GitTarget, type UpstreamDeps } from './upstream';
import { errPacket, pushReport, type RefOutcome, type ReportFormat } from './wire';
import { prefixed, refusalLine, refusalText, resultText } from './words';

/** The command list of a push may not exceed this many bytes (refs, not objects). */
export const MAX_COMMAND_LIST_BYTES = 1024 * 1024;
/** What the gateway calls itself in the capabilities it sends upstream. */
export const GIT_AGENT = 'vaubaan-gateway';
const BYTES_PER_MEGABYTE = 1024 * 1024;
const HTTP_UNAUTHORIZED = 401;
const NONCE_BYTES = 6;

export interface PushDeps extends UpstreamDeps {
  readonly config: Pick<InstanceConfig, 'git'>;
  readonly pipeline: CallPipeline;
  readonly pendingRefs: PendingRefsRepo;
  readonly logger: Logger;
}

export interface PushInput {
  readonly request: Request;
  readonly ctx: MissionContext;
  readonly client: ClientOrigin;
  readonly target: GitTarget;
  readonly agentLabel: string | null;
  /** Aborted at `git.request_timeout` or when git hangs up. */
  readonly signal: AbortSignal;
}

/** A command whose pack was stored under a temporary ref. */
interface StoredRef {
  readonly ref: string;
  readonly temporary: string;
  readonly objectId: string;
}

/** The push could not go on: what git is told, what the audit keeps. */
class PushStop extends Error {
  constructor(
    readonly reason: string,
    readonly audited: string,
  ) {
    super(reason);
    this.name = 'PushStop';
  }
}

class PackTooLarge extends Error {
  constructor() {
    super('pack too large');
    this.name = 'PackTooLarge';
  }
}

/** Reads one push and answers it. */
export class Push {
  private stored: readonly StoredRef[] = [];
  private execCtx: ExecuteContext | null = null;
  private upstreamWrite: GitUpstream | null = null;

  constructor(
    private readonly deps: PushDeps,
    private readonly input: PushInput,
  ) {}

  private call(args: Record<string, unknown>): CallRequest {
    const { input } = this;
    return {
      tool: input.target.remote.pushTool,
      args,
      channel: 'git',
      agent_label: input.agentLabel,
      client: input.client,
      signal: input.signal,
    };
  }

  async handle(): Promise<Response> {
    const { request, ctx, target } = this.input;
    if (!request.body || hasContentEncoding(request)) {
      return this.unreadable('a push body must be sent uncompressed');
    }
    const reader = new PktLineReader(request.body);
    let list: CommandList;
    try {
      list = await readCommandList(async () => {
        const pkt = await reader.read();
        if (reader.bytesRead > MAX_COMMAND_LIST_BYTES) {
          throw new GitProtocolError('the command list of this push is too long');
        }
        return pkt;
      });
    } catch (err) {
      if (err instanceof GitProtocolError || err instanceof PktLineError) {
        return this.unreadable(`this push could not be read: ${err.message}`);
      }
      throw err;
    }
    if (list.pushCert) return this.unreadable('signed pushes are not supported');

    const format: ReportFormat = {
      reportStatus: list.capabilities.includes('report-status'),
      sideBand: list.capabilities.includes('side-band-64k'),
    };
    const commands = list.commands;
    const refused = (reason: string, messages = ''): Response =>
      pushReport({
        format,
        unpack: 'ok',
        refs: commands.map((c) => ({ ref: c.ref, error: reason })),
        messages,
      });

    // 2. Precheck: refusals the mission's permissions make certain, before any byte leaves.
    const early = await this.deps.pipeline.precheck(
      ctx,
      this.call({ repository: target.repository, updates: commands.map(provisional) }),
    );
    if (early) return this.answerOutcome(early, commands, format);

    try {
      await this.store(reader, list);
      const review = await this.review(commands);
      const outcome = await this.deps.pipeline.execute(
        ctx,
        this.call({ repository: target.repository, updates: [...review] }),
      );
      const kept = outcome.kind === 'refused' && outcome.refusal.code === 'approval-required';
      if (kept) await this.keepForApproval(outcome.refusal.expires_at);
      else await this.cleanUp(this.stored);
      if (outcome.kind === 'allowed') await this.cleanUpEarlierRequests(review);
      return this.answerOutcome(outcome, commands, format);
    } catch (err) {
      await this.cleanUp(this.stored);
      if (!(err instanceof PushStop)) throw err;
      const outcome = await this.deps.pipeline.reject(
        ctx,
        this.call({ repository: target.repository, updates: commands.map(provisional) }),
        err.reason,
        err.audited,
      );
      this.log(outcome);
      return refused(err.reason, prefixed(err.reason));
    }
  }

  /** A request that is not a readable push: one audit entry, one `ERR` line. */
  private async unreadable(reason: string): Promise<Response> {
    const outcome = await this.deps.pipeline.reject(
      this.input.ctx,
      this.call({ repository: this.input.target.repository }),
      reason,
    );
    this.log(outcome);
    return errPacket(RECEIVE_PACK_SERVICE, reason);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Store the pack under temporary refs
  // ───────────────────────────────────────────────────────────────────────────

  private async upstream(): Promise<{ execCtx: ExecuteContext; upstream: GitUpstream }> {
    if (this.execCtx && this.upstreamWrite) {
      return { execCtx: this.execCtx, upstream: this.upstreamWrite };
    }
    const { ctx, target, signal } = this.input;
    try {
      this.execCtx = await executeContextFor(this.deps, ctx, target, signal);
      this.upstreamWrite = await target.remote.upstream(this.execCtx, target.repository, 'write');
    } catch (err) {
      // The plugin declined (a permission the account lacks): its sentence, as it is.
      if (err instanceof ExecutorRefusal) throw new PushStop(err.message, err.message);
      throw new PushStop(
        `the ${target.plugin.displayName} account of this mission could not be used (${errorName(err)}); tell the human`,
        `the provider account could not be used (${errorName(err)})`,
      );
    }
    return { execCtx: this.execCtx, upstream: this.upstreamWrite };
  }

  private async store(reader: PktLineReader, list: CommandList): Promise<void> {
    const { ctx, target, signal } = this.input;
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    const toStore = list.commands.filter((c): c is RefCommand & { new: string } => c.new !== null);
    if (toStore.length === 0) return;
    const stored = toStore.map((c, i) => ({
      ref: c.ref,
      temporary: `${GIT_TEMPORARY_REF_PREFIX}${ctx.mission.id}/${nonce}/${i}`,
      objectId: c.new,
    }));
    const { execCtx, upstream } = await this.upstream();
    const capabilities = [
      'report-status',
      'side-band-64k',
      'quiet',
      ...list.capabilities.filter((c) => c === 'ofs-delta' || c.startsWith('object-format=')),
      `agent=${GIT_AGENT}`,
    ];
    const head = concatBytes([
      ...list.shallow.map((oid) => pktLine(`shallow ${oid}`)),
      encodeCommandList(
        stored.map((s) => ({ old: null, new: s.objectId, ref: s.temporary })),
        capabilities,
      ),
    ]);
    const limit = this.deps.config.git.maxPackBytes;
    const pack = capped(reader.rest(), limit);
    // From here the provider may hold the refs: they are cleaned up whatever follows.
    this.stored = stored;
    let answer: Response;
    try {
      answer = await callUpstream(execCtx, upstream, {
        method: 'POST',
        suffix: `/${RECEIVE_PACK_SERVICE}`,
        headers: new Headers({
          'content-type': RECEIVE_PACK_REQUEST_TYPE,
          accept: RECEIVE_PACK_RESULT_TYPE,
        }),
        body: prepended(head, pack.stream),
        signal,
      });
    } catch (err) {
      throw this.uploadFailure(err, pack.exceeded(), limit);
    }
    if (pack.exceeded()) {
      await answer.body?.cancel();
      throw this.uploadFailure(new PackTooLarge(), true, limit);
    }
    if (!answer.ok) {
      await answer.body?.cancel();
      if (answer.status === HTTP_UNAUTHORIZED) {
        await this.deps.credentialCache.drop(target.connection.id);
      }
      throw new PushStop(
        `${target.plugin.displayName} refused to store the pack (HTTP ${answer.status}); push again, and tell the human if it persists`,
        `the provider refused to store the pack (HTTP ${answer.status})`,
      );
    }
    let report;
    try {
      report = parseReceivePackResult(new Uint8Array(await answer.arrayBuffer()), true);
    } catch (err) {
      throw this.uploadFailure(err, pack.exceeded(), limit);
    }
    const failed = stored.map((s) => report.refs.get(s.temporary)).find((r) => !r || !r.ok);
    if (report.unpack !== 'ok' || failed !== undefined) {
      const detail =
        report.unpack !== 'ok'
          ? report.unpack
          : failed && !failed.ok
            ? failed.error
            : 'no status reported';
      throw new PushStop(
        `${target.plugin.displayName} could not store the pack: ${firstLine(detail || report.errors)}`,
        'the provider could not store the pack',
      );
    }
  }

  private uploadFailure(err: unknown, exceeded: boolean, limit: number): PushStop {
    if (exceeded) {
      const mb = Math.floor(limit / BYTES_PER_MEGABYTE);
      return new PushStop(
        `this push is larger than the ${mb} MB this gateway accepts; push fewer commits at a time`,
        `the push is larger than the ${mb} MB limit`,
      );
    }
    if (this.input.signal.aborted) {
      return new PushStop(
        'this push took longer than this gateway allows; push fewer commits at a time',
        'the push exceeded the request timeout',
      );
    }
    return new PushStop(
      `the pack could not be sent to ${this.input.target.plugin.displayName} (${errorName(err)}); push again`,
      `the pack could not be sent to the provider (${errorName(err)})`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Review
  // ───────────────────────────────────────────────────────────────────────────

  private async review(commands: readonly RefCommand[]): Promise<readonly GitReviewedUpdate[]> {
    const { target } = this.input;
    const { execCtx } = await this.upstream();
    let review: GitReview;
    try {
      review = await target.remote.review(execCtx, target.repository, commands);
    } catch (err) {
      throw new PushStop(
        `${target.plugin.displayName} could not be asked what this push changes (${errorName(err)}); push again`,
        `the review of the push failed (${errorName(err)})`,
      );
    }
    if (!review.ok) throw new PushStop(review.reason, review.reason);
    return review.updates;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Temporary refs: kept for a pending approval, deleted otherwise
  // ───────────────────────────────────────────────────────────────────────────

  private async keepForApproval(expiresAt: string): Promise<void> {
    const { ctx, target } = this.input;
    await this.deps.pendingRefs.add(
      this.stored.map((s) => ({
        ref: s.temporary,
        connectionId: target.connection.id,
        repository: target.repository,
        missionId: ctx.mission.id,
        objectId: s.objectId,
        expiresAt,
      })),
    );
  }

  private async cleanUp(stored: readonly StoredRef[]): Promise<void> {
    if (stored.length === 0) return;
    try {
      const { execCtx, upstream } = await this.upstream();
      await deleteTemporaryRefs(execCtx, upstream, stored, this.input.signal);
    } catch (err) {
      this.deps.logger.warn('temporary refs of a push not deleted', {
        mission_id: this.input.ctx.mission.id,
        refs: stored.length,
        error: errorName(err),
      });
    }
  }

  /** An allowed replay: what the earlier push of the same commits left for its request. */
  private async cleanUpEarlierRequests(review: readonly GitReviewedUpdate[]): Promise<void> {
    const { ctx, target } = this.input;
    const pushed = new Set(review.map((u) => u.new).filter((oid) => oid !== null));
    const earlier = (await this.deps.pendingRefs.listFor(ctx.mission.id, target.repository)).filter(
      (r) => pushed.has(r.objectId),
    );
    if (earlier.length === 0) return;
    await this.cleanUp(
      earlier.map((r) => ({ ref: r.ref, temporary: r.ref, objectId: r.objectId })),
    );
    await this.deps.pendingRefs.remove(earlier.map((r) => r.ref));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The answer git reads
  // ───────────────────────────────────────────────────────────────────────────

  private answerOutcome(
    outcome: CallOutcome,
    commands: readonly RefCommand[],
    format: ReportFormat,
  ): Response {
    this.log(outcome);
    const all = (reason: string, messages: string): Response =>
      pushReport({
        format,
        unpack: 'ok',
        refs: commands.map((c) => ({ ref: c.ref, error: reason })),
        messages,
      });
    switch (outcome.kind) {
      case 'refused':
        return all(refusalLine(outcome.refusal), messagesOf(outcome.refusal));
      case 'rejected':
        return all(outcome.reason, prefixed(outcome.reason));
      case 'failed': {
        if (outcome.refusal) {
          return all(refusalLine(outcome.refusal), messagesOf(outcome.refusal));
        }
        const reason = `${this.input.target.plugin.displayName} refused the update: ${firstLine(outcome.error)}`;
        return all(reason, prefixed(reason));
      }
      case 'allowed': {
        const refs = refOutcomes(outcome.result, commands);
        return pushReport({ format, unpack: 'ok', refs });
      }
    }
  }

  private log(outcome: CallOutcome): void {
    const { ctx } = this.input;
    // Arguments are never logged; the audit entry carries their fingerprint.
    this.deps.logger.info('git push', {
      mission_id: ctx.mission.id,
      token_prefix: ctx.token.prefix,
      outcome: outcome.kind,
      refusal_code: outcome.audit.refusal_code,
      arguments_hash: outcome.audit.arguments_hash,
      agent_label: outcome.audit.agent_label,
    });
  }
}

/** What git sent, before any review: the precheck's arguments. */
function provisional(c: RefCommand): GitReviewedUpdate {
  return {
    ref: c.ref,
    old: c.old,
    new: c.new,
    kind: c.old === null ? 'create' : c.new === null ? 'delete' : 'fast-forward',
    commits: 0,
    files: [],
    workflow_files: [],
  };
}

/** The messages of a refusal on the progress channel. */
function messagesOf(refusal: Refusal): string {
  if (refusal.code === 'approval-required') {
    return prefixed(
      [
        "This push needs the approval of the mission's creator. Nothing was pushed.",
        `Hand this URL to your human: ${refusal.approval_url}`,
        `Once approved, push the same commits again within ${refusal.approval_valid_seconds} s; a changed commit asks again.`,
      ].join('\n'),
    );
  }
  return refusalText(refusal);
}

/** Per-ref outcome of the push tool's result (`GitPushResult` in its text). */
function refOutcomes(result: unknown, commands: readonly RefCommand[]): RefOutcome[] {
  const text = resultText(result);
  let parsed: GitPushResult | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as GitPushResult).updates)
    ) {
      parsed = value as GitPushResult;
    }
  } catch {
    parsed = null;
  }
  return commands.map((c) => {
    const u = parsed?.updates.find((x) => x.ref === c.ref);
    if (!parsed) return { ref: c.ref, error: firstLine(text) || 'the update was not applied' };
    if (!u) return { ref: c.ref, error: 'no status reported' };
    return { ref: c.ref, error: u.ok ? null : (u.error ?? 'rejected') };
  });
}

/** Delete temporary refs at the provider: compare-and-swap on what they point at. */
export async function deleteTemporaryRefs(
  ctx: ExecuteContext,
  upstream: GitUpstream,
  refs: readonly { readonly temporary: string; readonly objectId: string }[],
  signal?: AbortSignal,
): Promise<void> {
  const sent = await sendRefUpdates({
    fetch: ctx.fetch,
    upstream,
    commands: refs.map((r) => ({ old: r.objectId, new: null, ref: r.temporary })),
    agent: GIT_AGENT,
    ...(signal ? { signal } : {}),
  });
  if (!sent.report) throw new Error(`HTTP ${sent.status}`);
}

/** `stream`, cut with an error once more than `limit` bytes went through. */
function capped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): { readonly stream: ReadableStream<Uint8Array>; readonly exceeded: () => boolean } {
  let seen = 0;
  let over = false;
  const reader = stream.getReader();
  return {
    exceeded: () => over,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.length;
        if (seen > limit) {
          // The rest of the body is left unread: the server discards it once the
          // answer is sent, so git reads the refusal instead of a broken pipe.
          over = true;
          controller.error(new PackTooLarge());
          return;
        }
        controller.enqueue(value);
      },
    }),
  };
}

/** `head`, then every chunk of `rest`. */
function prepended(head: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let headSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(head);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function hasContentEncoding(request: Request): boolean {
  const encoding = request.headers.get('content-encoding');
  return encoding !== null && encoding.trim().toLowerCase() !== 'identity';
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim().slice(0, 300);
}
