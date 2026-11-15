/**
 * The temporary refs of a push (spec §4.1 ter; ADR gateway-as-git-remote D4,
 * D5): the pack stored at the service under `refs/vaubaan/<random>` so that
 * the service can say what it brings, then deleted — on every path. The pack
 * reaches this module read whole, inspected and decided on (`push.ts`, ADR
 * gateway-as-git-remote): a push its mission refuses for what
 * its objects change never gets here.
 *
 *   names     random, carrying no mission id: every reader of the repository
 *             can list them while they exist (the fetch listings of the door
 *             hide them, the service's own interface does not);
 *   rows      one per ref (`git_pending_refs`), written before a byte leaves,
 *             with the request's deadline; dropped once the service confirmed
 *             the ref gone, kept for the sweeper otherwise;
 *   ceiling   a mission holds at most `MAX_TEMPORARY_REFS_PER_MISSION` refs at
 *             once, in flight or waiting for an approval;
 *   approval  a push waiting for one keeps its refs until the request expires;
 *             a later push of the same mission to the same ref supersedes them.
 */
import { randomBytes } from 'node:crypto';

import type { MissionContext } from '@vaubaan/gateway-core';
import { type ExecuteContext, isExecutorRefusal } from '@vaubaan/plugin-sdk';
import {
  advertisementType,
  concatBytes,
  encodeCommandList,
  GIT_TEMPORARY_REF_PREFIX,
  parseAdvertisement,
  parseReceivePackResult,
  pktLine,
  RECEIVE_PACK_REQUEST_TYPE,
  RECEIVE_PACK_RESULT_TYPE,
  RECEIVE_PACK_SERVICE,
  sendRefUpdates,
  type CommandList,
  type GitReviewedUpdate,
  type GitUpstream,
  type RefCommand,
} from '@vaubaan/plugin-sdk/git';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { PendingRefsRepo } from '../store';
import {
  CLEANUP_TIMEOUT_MS,
  GIT_AGENT,
  HTTP_FORBIDDEN,
  HTTP_UNAUTHORIZED,
  IN_FLIGHT_MARGIN_MS,
  MAX_TEMPORARY_REFS_PER_MISSION,
  MS_PER_SECOND,
} from './constants';
import { interrupted, PushStop } from './push-stop';
import { callUpstream, executeContextFor, type GitTarget, type UpstreamDeps } from './upstream';

/** Random bytes of a temporary ref's name. */
const TEMPORARY_REF_BYTES = 16;

/** `refs/vaubaan/<32 hex>`: unique, and telling nothing of the mission. */
export function temporaryRefName(): string {
  return `${GIT_TEMPORARY_REF_PREFIX}${randomBytes(TEMPORARY_REF_BYTES).toString('hex')}`;
}

export function isTemporaryRef(name: string): boolean {
  return name.startsWith(GIT_TEMPORARY_REF_PREFIX);
}

export { PushStop } from './push-stop';

/** A command whose pack was stored under a temporary ref. */
export interface StoredRef {
  /** The branch or tag the push asked for. */
  readonly ref: string;
  readonly temporary: string;
  readonly objectId: string;
}

/**
 * Delete temporary refs at the service, a compare-and-swap on what each
 * points at. Returns the refs that are gone: those the service reported
 * `ok`, and those it refused that it no longer lists (already gone). A ref it
 * refused and still lists stays: its row is kept for the sweeper.
 */
export async function deleteTemporaryRefs(
  ctx: ExecuteContext,
  upstream: GitUpstream,
  refs: readonly { readonly temporary: string; readonly objectId: string }[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const sent = await sendRefUpdates({
    fetch: ctx.fetch,
    upstream,
    commands: refs.map((r) => ({ old: r.objectId, new: null, ref: r.temporary })),
    agent: GIT_AGENT,
    ...(signal ? { signal } : {}),
  });
  if (!sent.report) throw new Error(`HTTP ${sent.status}`);
  const gone = new Set<string>();
  const refused: string[] = [];
  for (const r of refs) {
    if (sent.report.refs.get(r.temporary)?.ok === true) gone.add(r.temporary);
    else refused.push(r.temporary);
  }
  if (refused.length === 0) return gone;
  const listed = await listedRefs(ctx, upstream, signal);
  for (const ref of refused) if (!listed.has(ref)) gone.add(ref);
  return gone;
}

/** The refs the service's receive-pack advertises now. */
async function listedRefs(
  ctx: ExecuteContext,
  upstream: GitUpstream,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const answer = await callUpstream(ctx, upstream, {
    method: 'GET',
    suffix: `/info/refs?service=${RECEIVE_PACK_SERVICE}`,
    headers: new Headers({ accept: advertisementType(RECEIVE_PACK_SERVICE) }),
    body: null,
    ...(signal ? { signal } : {}),
  });
  if (!answer.ok) {
    await answer.body?.cancel();
    throw new Error(`HTTP ${answer.status}`);
  }
  const ad = parseAdvertisement(new Uint8Array(await answer.arrayBuffer()));
  return new Set(ad.refs.map((r) => r.name));
}

export interface TemporaryRefsDeps extends UpstreamDeps {
  readonly config: Pick<InstanceConfig, 'git'>;
  readonly pendingRefs: PendingRefsRepo;
  readonly logger: Logger;
}

export interface TemporaryRefsScope {
  readonly ctx: MissionContext;
  readonly target: GitTarget;
  /** The request's signal: aborted at `git.request_timeout` or when git hangs up. */
  readonly signal: AbortSignal;
}

/** The temporary refs of one push, and the write access to the service they need. */
export class TemporaryRefs {
  private storedRefs: readonly StoredRef[] = [];
  private account: { execCtx: ExecuteContext; upstream: GitUpstream } | null = null;

  constructor(
    private readonly deps: TemporaryRefsDeps,
    private readonly scope: TemporaryRefsScope,
  ) {}

  get stored(): readonly StoredRef[] {
    return this.storedRefs;
  }

  /** The plugin's context and the write endpoint, minted once per push. */
  async upstream(): Promise<{ execCtx: ExecuteContext; upstream: GitUpstream }> {
    if (this.account) return this.account;
    const { ctx, target, signal } = this.scope;
    try {
      const execCtx = await executeContextFor(this.deps, ctx, target, signal);
      const upstream = await target.remote.upstream(execCtx, target.repository, 'write');
      this.account = { execCtx, upstream };
      return this.account;
    } catch (err) {
      // The plugin declined (a permission the account lacks): its sentence, as it is.
      if (isExecutorRefusal(err)) throw new PushStop(err.message, err.message);
      throw new PushStop(
        `the ${target.plugin.displayName} account of this mission could not be used (${errorName(err)}); tell the human`,
        `the service account could not be used (${errorName(err)})`,
      );
    }
  }

  /**
   * Ask the plugin for the write endpoint again, in the same context: the
   * plugin may have renewed its credential since (`gitRemote.admitPush`).
   */
  async renewUpstream(): Promise<void> {
    this.account = null;
    await this.upstream();
  }

  /**
   * Send the pack — already read whole, inspected and decided on — to the
   * service under one temporary ref per created or moved ref.
   */
  async store(pack: Uint8Array, list: CommandList): Promise<void> {
    const { ctx, target, signal } = this.scope;
    const toStore = list.commands.filter((c): c is RefCommand & { new: string } => c.new !== null);
    if (toStore.length === 0) return;
    await this.checkCeiling(toStore.length);
    const stored = toStore.map((c) => ({
      ref: c.ref,
      temporary: temporaryRefName(),
      objectId: c.new,
    }));
    const { execCtx, upstream } = await this.upstream();
    const capabilities = [
      'report-status',
      'side-band-64k',
      'quiet',
      ...list.capabilities.filter((c) => c === 'ofs-delta' || c === 'object-format=sha1'),
      `agent=${GIT_AGENT}`,
    ];
    const head = concatBytes([
      ...list.shallow.map((oid) => pktLine(`shallow ${oid}`)),
      encodeCommandList(
        stored.map((s) => ({ old: null, new: s.objectId, ref: s.temporary })),
        capabilities,
      ),
    ]);
    // Recorded before a byte leaves: if this process dies or the client goes
    // away mid-push, the sweeper finds them once the deadline has passed.
    const deadline = new Date(
      Date.now() + this.deps.config.git.requestTimeoutSeconds * MS_PER_SECOND + IN_FLIGHT_MARGIN_MS,
    ).toISOString();
    await this.deps.pendingRefs.add(
      stored.map((r) => ({
        ref: r.temporary,
        targetRef: r.ref,
        accountId: target.account.id,
        repository: target.repository,
        missionId: ctx.mission.id,
        objectId: r.objectId,
        expiresAt: deadline,
      })),
    );
    // From here the service may hold the refs: they are cleaned up whatever follows.
    this.storedRefs = stored;
    let answer: Response;
    try {
      answer = await callUpstream(execCtx, upstream, {
        method: 'POST',
        suffix: `/${RECEIVE_PACK_SERVICE}`,
        headers: new Headers({
          'content-type': RECEIVE_PACK_REQUEST_TYPE,
          accept: RECEIVE_PACK_RESULT_TYPE,
        }),
        // Two chunks, the pack not copied.
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(head);
            if (pack.length > 0) controller.enqueue(pack);
            controller.close();
          },
        }),
        signal,
      });
    } catch (err) {
      throw this.uploadFailure(err);
    }
    if (!answer.ok) {
      await answer.body?.cancel();
      if (answer.status === HTTP_UNAUTHORIZED) {
        await this.deps.credentialCache.drop(target.account.id);
      }
      // A 403 on the upload is the service's own permission check: the account's
      // token cannot write to this repository.
      if (answer.status === HTTP_FORBIDDEN) {
        throw new PushStop(
          `${target.plugin.displayName} refused the push for a permission the account's token lacks (HTTP 403): the token needs write access to this repository; its owner creates one with it and reconnects the account.`,
          'the service refused the push for a permission the token lacks (HTTP 403)',
        );
      }
      throw new PushStop(
        `${target.plugin.displayName} refused to store the pack (HTTP ${answer.status}); push again, and tell the human if it persists`,
        `the service refused to store the pack (HTTP ${answer.status})`,
      );
    }
    let report;
    try {
      report = parseReceivePackResult(new Uint8Array(await answer.arrayBuffer()), true);
    } catch (err) {
      throw this.uploadFailure(err);
    }
    const failed = stored.map((s) => report.refs.get(s.temporary)).find((r) => !r || !r.ok);
    if (report.unpack !== 'ok' || failed !== undefined) {
      // A refusal may come from a credential minted before a permission was
      // granted (GitHub: "… without `workflows` permission"): the next push
      // starts from a fresh one.
      await this.deps.credentialCache.drop(target.account.id);
      const detail =
        report.unpack !== 'ok'
          ? report.unpack
          : failed && !failed.ok
            ? failed.error
            : 'no status reported';
      throw new PushStop(
        `${target.plugin.displayName} could not store the pack: ${firstLine(detail || report.errors)}`,
        'the service could not store the pack',
      );
    }
  }

  /** A mission holds a bounded number of temporary refs at the service. */
  private async checkCeiling(adding: number): Promise<void> {
    const held = await this.deps.pendingRefs.countFor(this.scope.ctx.mission.id);
    if (held + adding <= MAX_TEMPORARY_REFS_PER_MISSION) return;
    const reason = `this mission already holds ${held} temporary refs at ${this.scope.target.plugin.displayName} for pushes waiting for an answer (at most ${MAX_TEMPORARY_REFS_PER_MISSION}); have the waiting requests answered, or let them expire, then push again`;
    throw new PushStop(
      reason,
      `the mission holds ${held} temporary refs (limit ${MAX_TEMPORARY_REFS_PER_MISSION})`,
    );
  }

  private uploadFailure(err: unknown): PushStop {
    const stopped = interrupted(this.scope.signal);
    if (stopped) return stopped;
    return new PushStop(
      `the pack could not be sent to ${this.scope.target.plugin.displayName} (${errorName(err)}); push again`,
      `the pack could not be sent to the service (${errorName(err)})`,
    );
  }

  /**
   * The push waits for an approval: its refs stay until the request expires,
   * so the person who answers reads the change at the service. What an
   * earlier push of the same mission left waiting for the same refs is
   * superseded and deleted.
   */
  async keepForApproval(expiresAt: string): Promise<void> {
    const { ctx, target } = this.scope;
    const mine = new Set(this.storedRefs.map((s) => s.temporary));
    const targets = new Set(this.storedRefs.map((s) => s.ref));
    const superseded = (
      await this.deps.pendingRefs.listFor(ctx.mission.id, target.repository)
    ).filter((row) => !mine.has(row.ref) && targets.has(row.targetRef));
    await this.deps.pendingRefs.extend([...mine], expiresAt);
    await this.cleanUp(
      superseded.map((r) => ({ ref: r.targetRef, temporary: r.ref, objectId: r.objectId })),
    );
  }

  /** An allowed replay: what earlier pushes of the same commits left for their requests. */
  async cleanUpEarlier(review: readonly GitReviewedUpdate[]): Promise<void> {
    const { ctx, target } = this.scope;
    const pushed = new Set(review.map((u) => u.new).filter((oid) => oid !== null));
    const earlier = (await this.deps.pendingRefs.listFor(ctx.mission.id, target.repository)).filter(
      (r) => pushed.has(r.objectId),
    );
    await this.cleanUp(
      earlier.map((r) => ({ ref: r.targetRef, temporary: r.ref, objectId: r.objectId })),
    );
  }

  /**
   * Delete temporary refs at the service, then the rows of those confirmed
   * gone. Runs on every path with a deadline of its own, never the request's
   * signal. A ref the service kept keeps its row, for the sweeper.
   */
  async cleanUp(stored: readonly StoredRef[] = this.storedRefs): Promise<void> {
    if (stored.length === 0) return;
    try {
      const { execCtx, upstream } = await this.upstream();
      const deadline = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
      const gone = await deleteTemporaryRefs(
        { ...execCtx, signal: deadline },
        upstream,
        stored,
        deadline,
      );
      await this.deps.pendingRefs.remove([...gone]);
      if (gone.size < stored.length) {
        this.deps.logger.warn('temporary refs kept by the service; left to the sweeper', {
          mission_id: this.scope.ctx.mission.id,
          refs: stored.length - gone.size,
        });
      }
    } catch (err) {
      this.deps.logger.warn('temporary refs of a push not deleted', {
        mission_id: this.scope.ctx.mission.id,
        refs: stored.length,
        error: errorName(err),
      });
    }
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim().slice(0, 300);
}
