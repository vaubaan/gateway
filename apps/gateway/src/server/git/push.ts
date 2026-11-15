/**
 * A push through the git remote (spec §4.1 ter; ADR gateway-as-git-remote D4–D6).
 *
 *   1. read     the command list, bounded and judged (`command-list.ts`); the
 *               pack stays in the stream
 *   2. admit    at most `MAX_PUSHES_IN_FLIGHT_PER_MISSION` pushes of a mission at once
 *   3. precheck with the updates as git sent them (fast-forward assumed, no
 *               files), the limits included: a push its mission or its budget
 *               refuses is refused, and audited, before any byte leaves
 *   4. inspect  the pack read whole (at most `git.max_pack_mb`), its objects
 *               hashed here, and the plugin asked what each tip changes in the
 *               CI workflows (`gitRemote.inspectPack`); a change found is
 *               prechecked again: a mission that may not change CI is refused
 *               before any byte leaves (ADR gateway-as-git-remote)
 *   4b. admit   the plugin asked whether its credential can carry the push
 *               (`gitRemote.admitPush`: a CI workflow change needs the
 *               service permission to change workflows) — after the
 *               mission's decision, before any byte leaves
 *   5. store   the pack at the service under temporary refs (`temporary-refs.ts`)
 *   6. review   each update at the service (`gitRemote.review`), the
 *               inspection's workflow paths added to it
 *   7. decide   one call, the reviewed updates as arguments
 *   8. move     allowed: the plugin's `execute` moves the real refs
 *   9. clean    the temporary refs are deleted — except while the push waits
 *               for an approval
 *
 * Every refusal reaches git as `ng <ref> <reason>` on each ref of the push
 * (`report.ts`), and the instruction on `remote:` lines.
 */
import type {
  CallOutcome,
  CallPipeline,
  CallRequest,
  ClientOrigin,
  MissionContext,
} from '@vaubaan/gateway-core';
import {
  PktLineReader,
  readPackObjects,
  RECEIVE_PACK_SERVICE,
  type CommandList,
  type GitInspectedUpdate,
  type GitReview,
  type GitReviewedUpdate,
} from '@vaubaan/plugin-sdk/git';

import type { Logger } from '../logging';
import { provisional, readPushCommands } from './command-list';
import type { InFlightPushes } from './in-flight';
import { readPack } from './pack-buffer';
import { refuseAll, reportOf } from './report';
import { errorName, PushStop, TemporaryRefs, type TemporaryRefsDeps } from './temporary-refs';
import type { GitTarget } from './upstream';
import { errPacket, type ReportFormat } from './wire';

export interface PushDeps extends TemporaryRefsDeps {
  readonly pipeline: CallPipeline;
  readonly inFlight: InFlightPushes;
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

/** Reads one push and answers it. */
export class Push {
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
    const { request, ctx } = this.input;
    if (!request.body || hasContentEncoding(request)) {
      return this.unreadable('a push body must be sent uncompressed');
    }
    const reader = new PktLineReader(request.body);
    const read = await readPushCommands(reader);
    if ('issue' in read) return this.unreadable(read.issue);
    const { list } = read;
    const format: ReportFormat = {
      reportStatus: true,
      sideBand: list.capabilities.includes('side-band-64k'),
    };

    const release = this.deps.inFlight.acquire(ctx.mission.id);
    if (!release) {
      return this.stopped(
        list,
        format,
        new PushStop(
          'another push of this mission is still running; push again once it ends',
          'another push of the mission was in flight',
        ),
      );
    }
    try {
      return await this.decide(reader, list, format);
    } finally {
      release();
    }
  }

  private async decide(
    reader: PktLineReader,
    list: CommandList,
    format: ReportFormat,
  ): Promise<Response> {
    const { ctx, target } = this.input;
    const commands = list.commands;
    const early = await this.deps.pipeline.precheck(
      ctx,
      this.call({ repository: target.repository, updates: commands.map(provisional) }),
      { limits: true },
    );
    if (early) return this.answer(early, list, format);

    const refs = new TemporaryRefs(this.deps, this.input);
    try {
      const pack = await readPack(reader, this.deps.config.git.maxPackBytes, this.input.signal);
      const inspected = await this.inspect(refs, list, pack);
      if (inspected.some((u) => u.workflow_files.length > 0)) {
        // What the push's own objects change, decided before a byte leaves.
        const refused = await this.deps.pipeline.precheck(
          ctx,
          this.call({ repository: target.repository, updates: [...inspected] }),
          { limits: true },
        );
        if (refused) return this.answer(refused, list, format);
      }
      // The mission has decided on what the push changes; whether the
      // service's credential can carry it is asked now, before a byte leaves.
      await this.admit(refs, inspected);
      await refs.store(pack, list);
      const review = withInspection(await this.review(refs, list), inspected);
      const outcome = await this.deps.pipeline.execute(
        ctx,
        this.call({ repository: target.repository, updates: [...review] }),
      );
      if (outcome.kind === 'refused' && outcome.refusal.code === 'approval-required') {
        await refs.keepForApproval(outcome.refusal.expires_at);
      } else {
        await refs.cleanUp();
      }
      if (outcome.kind === 'allowed') await refs.cleanUpEarlier(review);
      return this.answer(outcome, list, format);
    } catch (err) {
      await refs.cleanUp();
      if (!(err instanceof PushStop)) throw err;
      return this.stopped(list, format, err);
    }
  }

  /**
   * The provisional updates with what the plugin found in the push's own
   * objects (ADR gateway-as-git-remote). Fail closed: a pack
   * whose objects cannot be read leaves them unknown, which the plugin counts
   * as changed; a plugin that fails refuses the push.
   */
  private async inspect(
    refs: TemporaryRefs,
    list: CommandList,
    pack: Uint8Array,
  ): Promise<readonly GitReviewedUpdate[]> {
    const { target } = this.input;
    const updates = list.commands.map(provisional);
    const inspectPack = target.remote.inspectPack?.bind(target.remote);
    if (!inspectPack || list.commands.every((c) => c.new === null)) return updates;
    const objects = await readPackObjects(pack);
    const { execCtx } = await refs.upstream();
    let found: readonly GitInspectedUpdate[];
    try {
      found = await inspectPack(execCtx, target.repository, list.commands, objects);
    } catch (err) {
      throw new PushStop(
        `the gateway could not tell whether this push changes CI workflows (${errorName(err)}); push again`,
        `the inspection of the push failed (${errorName(err)})`,
      );
    }
    return updates.map((u) => {
      const own = found.find((f) => f.ref === u.ref);
      if (own === undefined && u.new !== null) {
        // An update the plugin did not answer for is unknown: refused.
        throw new PushStop(
          'the gateway could not tell whether this push changes CI workflows; push again',
          'the inspection of the push left an update out',
        );
      }
      return { ...u, workflow_files: [...(own?.workflow_files ?? [])] };
    });
  }

  /**
   * The plugin's word on its credential (`gitRemote.admitPush`): a push the
   * account cannot carry — a CI workflow change without the permission to
   * change workflows — is refused by name with nothing sent. Asked after the
   * mission's precheck, so the mission's decision never depends on the
   * account. The plugin may have renewed its credential: the write endpoint
   * is asked for again before the store.
   */
  private async admit(refs: TemporaryRefs, inspected: readonly GitReviewedUpdate[]): Promise<void> {
    const { target } = this.input;
    const admitPush = target.remote.admitPush?.bind(target.remote);
    if (!admitPush || inspected.every((u) => u.new === null)) return;
    const { execCtx } = await refs.upstream();
    let refusal: string | null;
    try {
      refusal = await admitPush(execCtx, target.repository, inspected);
    } catch (err) {
      throw new PushStop(
        `the gateway could not tell whether the ${target.plugin.displayName} account can carry this push (${errorName(err)}); push again`,
        `the admission of the push failed (${errorName(err)})`,
      );
    }
    if (refusal !== null) throw new PushStop(refusal, refusal);
    await refs.renewUpstream();
  }

  private async review(
    refs: TemporaryRefs,
    list: CommandList,
  ): Promise<readonly GitReviewedUpdate[]> {
    const { target } = this.input;
    const { execCtx } = await refs.upstream();
    let review: GitReview;
    try {
      review = await target.remote.review(execCtx, target.repository, list.commands);
    } catch (err) {
      throw new PushStop(
        `${target.plugin.displayName} could not be asked what this push changes (${errorName(err)}); push again`,
        `the review of the push failed (${errorName(err)})`,
      );
    }
    if (!review.ok) throw new PushStop(review.reason, review.reason);
    return review.updates;
  }

  /** A push that could not go on: one audit entry, the reason on every ref. */
  private async stopped(
    list: CommandList,
    format: ReportFormat,
    stop: PushStop,
  ): Promise<Response> {
    const outcome = await this.deps.pipeline.reject(
      this.input.ctx,
      this.call({
        repository: this.input.target.repository,
        updates: list.commands.map(provisional),
      }),
      stop.reason,
      stop.audited,
    );
    this.log(outcome);
    return refuseAll(format, list.commands, stop.reason);
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

  private answer(outcome: CallOutcome, list: CommandList, format: ReportFormat): Response {
    this.log(outcome);
    return reportOf(outcome, list.commands, format, this.input.target.plugin.displayName);
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

/**
 * The review's updates, each with the workflow paths the inspection found
 * added: the decision covers both, so neither a review that misses a change
 * nor an inspection that misses one can make a push look smaller.
 */
export function withInspection(
  review: readonly GitReviewedUpdate[],
  inspected: readonly GitReviewedUpdate[],
): readonly GitReviewedUpdate[] {
  return review.map((u) => {
    const found = inspected.find((i) => i.ref === u.ref)?.workflow_files ?? [];
    if (found.length === 0) return u;
    return { ...u, workflow_files: [...new Set([...u.workflow_files, ...found])].sort() };
  });
}

function hasContentEncoding(request: Request): boolean {
  const encoding = request.headers.get('content-encoding');
  return encoding !== null && encoding.trim().toLowerCase() !== 'identity';
}
