/**
 * `execute` of `github__git_push` (ADR gateway-as-git-remote D4): the
 * reviewed updates moved at GitHub, in order, each reporting on its own like
 * git without `--atomic`. The arguments are the host's review, read again with
 * the grammars of `git-call.ts`.
 *
 *   create        POST  git/refs                    GitHub refuses an existing ref
 *   fast-forward  PATCH git/refs/<ref> force:false  GitHub refuses a non-fast-forward
 *   force         receive-pack `<old> <new> <ref>`  GitHub moves the ref only if it is
 *   delete        receive-pack `<old> 0000 <ref>`   still the reviewed `old`, under its
 *                                                   ref lock: a compare-and-swap. The
 *                                                   objects are already at GitHub
 *                                                   (temporary ref), so the pack is empty.
 *
 * A provider failure on one ref reports that ref and goes on with the next;
 * only a failure before any ref was tried fails the call.
 *
 * The push token's permissions are checked before any ref moves, against what
 * the review found (a workflow change needs `workflows: write`); a grant from
 * the cache that falls short is minted afresh first. When GitHub refuses a
 * move for a permission the token lacks ("Resource not accessible by
 * integration", "… without `workflows` permission"), the grant is minted
 * afresh once for the push and the move tried once more; refused again, the
 * ref's error names the permission.
 */
import {
  ExecutorRefusal,
  GIT_TEMPORARY_REF_PREFIX,
  UpstreamAuthError,
  UpstreamHttpError,
  sendRefUpdates,
  type ExecuteContext,
  type GitPushResult,
  type GitReviewedUpdate,
  type McpToolResult,
} from '@vaubaan/plugin-sdk';

import { githubRepoRefs } from './call.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL, readGitCall, type GitCall } from './git-call.ts';
import { gitGrant, upstream } from './git-credential.ts';
import { GithubRest, HTTP_UNAUTHORIZED, HTTP_UNPROCESSABLE, refPath } from './git-rest.ts';
import {
  assertGranted,
  gitPushNeeds,
  isMissingPermissionRefusal,
  missingPermissionSentence,
  refusedForPermissionSentence,
} from './permission-check.ts';

/** What the gateway calls itself in the capabilities it sends GitHub. */
const GIT_AGENT = 'vaubaan-gateway';
const HTTP_SERVER_ERROR = 500;

type MoveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function executeGit(
  ctx: ExecuteContext,
  tool: GitCall['tool'],
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const call = readGitCall(tool, args, githubRepoRefs(ctx.resources));
  if ('denied' in call) throw new ExecutorRefusal(`${tool}: ${call.denied}`);
  if (call.tool === GIT_FETCH_TOOL) {
    throw new ExecutorRefusal(
      `${GIT_FETCH_TOOL} is relayed by the gateway's git remote, never executed`,
    );
  }
  const needs = gitPushNeeds(call.updates.map((u) => u.update));
  let grant = await gitGrant(ctx, call.target, 'write');
  if (grant.cached && missingPermissionSentence(GIT_PUSH_TOOL, needs, grant.permissions) !== null) {
    // A cached grant may predate a permission granted since.
    grant = await gitGrant(ctx, call.target, 'write', { fresh: true });
  }
  assertGranted(GIT_PUSH_TOOL, needs, grant.permissions);
  const rest = new GithubRest(ctx, call.target);
  const mover = new RefMover(ctx, call.target.ref, rest, needs, !grant.cached);
  const updates: GitPushResult['updates'][number][] = [];
  for (const [i, { update }] of call.updates.entries()) {
    let outcome: MoveOutcome;
    try {
      outcome = await mover.move(update);
    } catch (err) {
      // Nothing moved yet: the call itself failed, as any tool's would.
      if (i === 0) throw err;
      outcome = {
        ok: false,
        error: `GitHub did not apply this update (${err instanceof Error ? err.name : 'Error'}); the refs before it moved`,
      };
    }
    updates.push({ ref: update.ref, ...outcome });
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ updates }) }],
    ...(updates.some((u) => !u.ok) ? { isError: true } : {}),
  };
}

class RefMover {
  constructor(
    private readonly ctx: ExecuteContext,
    private readonly repository: string,
    private readonly rest: GithubRest,
    private readonly needs: Readonly<Record<string, string>>,
    /** The push token was minted for this push: a refusal for a permission is final. */
    private renewed: boolean,
  ) {}

  /**
   * GitHub refused a move for a permission the token lacks: mint afresh once
   * for the push. `false` when it was already fresh — the refusal stands.
   */
  private async renewOnce(): Promise<boolean> {
    if (this.renewed) return false;
    this.renewed = true;
    await this.rest.renew('write');
    return true;
  }

  private refusedForPermission(githubSaid: string): MoveOutcome {
    return {
      ok: false,
      error: refusedForPermissionSentence(GIT_PUSH_TOOL, this.needs, githubSaid),
    };
  }

  async move(update: GitReviewedUpdate): Promise<MoveOutcome> {
    if (update.ref.startsWith(GIT_TEMPORARY_REF_PREFIX)) {
      return { ok: false, error: `'${GIT_TEMPORARY_REF_PREFIX}' is reserved by the gateway` };
    }
    switch (update.kind) {
      case 'create':
        return this.restWrite(update, 'POST', '/git/refs', { ref: update.ref, sha: update.new });
      case 'fast-forward':
        return this.restWrite(update, 'PATCH', `/git/refs/${refPath(update.ref)}`, {
          sha: update.new,
          force: false,
        });
      case 'force':
      case 'delete':
        return this.compareAndSwap(update);
    }
  }

  private async restWrite(
    update: GitReviewedUpdate,
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
  ): Promise<MoveOutcome> {
    let res = await this.rest.request('write', method, path, body);
    let message = res.ok ? '' : await messageOf(res);
    if (isMissingPermissionRefusal(res.status, message)) {
      if (!(await this.renewOnce())) return this.refusedForPermission(message);
      res = await this.rest.request('write', method, path, body);
      message = res.ok ? '' : await messageOf(res);
      if (isMissingPermissionRefusal(res.status, message))
        return this.refusedForPermission(message);
    }
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true };
    }
    if (res.status >= HTTP_SERVER_ERROR) {
      throw new UpstreamHttpError(`github ref write failed with HTTP ${res.status}`, res.status);
    }
    if (res.status === HTTP_UNPROCESSABLE && update.kind === 'fast-forward') {
      return {
        ok: false,
        error: `non-fast-forward (GitHub: ${message || 'Update is not a fast forward'}); fetch first`,
      };
    }
    return {
      ok: false,
      error: `GitHub refused the update (HTTP ${res.status}${message ? `: ${message}` : ''})`,
    };
  }

  /** The reviewed `old` as the expected value, checked by GitHub under the ref's lock. */
  private async compareAndSwap(update: GitReviewedUpdate): Promise<MoveOutcome> {
    const outcome = await this.sendCompareAndSwap(update);
    if (outcome.ok || !isMissingPermissionRefusal(null, outcome.error)) return outcome;
    if (!(await this.renewOnce())) return this.refusedForPermission(outcome.error);
    const again = await this.sendCompareAndSwap(update);
    if (again.ok || !isMissingPermissionRefusal(null, again.error)) return again;
    return this.refusedForPermission(again.error);
  }

  private async sendCompareAndSwap(update: GitReviewedUpdate): Promise<MoveOutcome> {
    const remote = await upstream(this.ctx, this.repository, 'write');
    const sent = await sendRefUpdates({
      fetch: this.ctx.fetch,
      upstream: remote,
      commands: [{ old: update.old, new: update.new, ref: update.ref }],
      agent: GIT_AGENT,
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
    });
    if (sent.status === HTTP_UNAUTHORIZED) {
      throw new UpstreamAuthError('github rejected the credential (HTTP 401)', HTTP_UNAUTHORIZED);
    }
    if (sent.report === null) {
      throw new UpstreamHttpError(`github receive-pack answered HTTP ${sent.status}`, sent.status);
    }
    const { report } = sent;
    if (report.unpack !== 'ok') return { ok: false, error: `unpack ${report.unpack}` };
    const status = report.refs.get(update.ref);
    if (!status) return { ok: false, error: 'GitHub reported nothing for this ref' };
    return status.ok
      ? { ok: true }
      : { ok: false, error: `${status.error} (the ref moved at GitHub since the review?)` };
  }
}

/** GitHub's `message` of a failed answer, or `''`. */
async function messageOf(res: Response): Promise<string> {
  try {
    const parsed = (await res.json()) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : '';
  } catch {
    return '';
  }
}
