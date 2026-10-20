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
 * When GitHub refuses a move for a permission the token lacks ("Resource not
 * accessible by personal access token", "… without `workflows` permission"),
 * the ref's error says so and points at the token's permissions.
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
import { HTTP_FORBIDDEN } from './api.ts';
import { upstream } from './git-credential.ts';
import { GITHUB_TOKEN_PERMISSIONS } from './permissions.ts';
import { GithubRest, HTTP_UNAUTHORIZED, HTTP_UNPROCESSABLE, refPath } from './git-rest.ts';

/** What the gateway calls itself in the capabilities it sends GitHub. */
const GIT_AGENT = 'vaubaan-gateway';
const HTTP_SERVER_ERROR = 500;

/**
 * GitHub's words for a token that lacks a permission: the REST API's
 * "Resource not accessible by personal access token", and the git push's
 * "refusing to allow a Personal Access Token to create or update workflow …
 * without `workflows` permission".
 */
const MISSING_PERMISSION_WORDS =
  /Resource not accessible by personal access token|without [`'"]?workflows[`'"]? permission|refusing to allow a Personal Access Token/i;

/** Whether GitHub refused a move for a permission the token lacks. A 403 for any other reason is not this. */
export function isMissingPermissionRefusal(status: number | null, message: string): boolean {
  return (status === null || status === HTTP_FORBIDDEN) && MISSING_PERMISSION_WORDS.test(message);
}

/** Longest part of GitHub's message a refusal quotes. */
const MAX_QUOTED_GITHUB_MESSAGE = 200;

/** The ref's error when GitHub refused its move for a permission the token lacks. */
export function refusedForPermissionSentence(githubSaid: string): string {
  const said = (githubSaid.split('\n')[0] ?? '').slice(0, MAX_QUOTED_GITHUB_MESSAGE);
  return `${GIT_PUSH_TOOL} was refused by GitHub for a permission the account's token lacks (GitHub: “${said}”). The token needs ${pushPermissionWords()}: create a token with them at GitHub and reconnect the account.`;
}

/** "Contents (read and write), and Workflows (read and write) for a change under .github/workflows/", read off the one declaration. */
function pushPermissionWords(): string {
  const named = GITHUB_TOKEN_PERMISSIONS.filter((p) => p.tools.includes(GIT_PUSH_TOOL));
  const words = named.map((p) => `${p.name} (${p.access === 'read' ? 'read' : 'read and write'})`);
  const workflows = named.findIndex((p) => p.name === 'Workflows');
  if (workflows >= 0) words[workflows] += ' for a change under .github/workflows/';
  return words.join(', and ');
}

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
  const rest = new GithubRest(ctx, call.target);
  const mover = new RefMover(ctx, call.target.ref, rest);
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
  ) {}

  private refusedForPermission(githubSaid: string): MoveOutcome {
    return { ok: false, error: refusedForPermissionSentence(githubSaid) };
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
    const res = await this.rest.request(method, path, body);
    const message = res.ok ? '' : await messageOf(res);
    if (isMissingPermissionRefusal(res.status, message)) return this.refusedForPermission(message);
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
    return this.refusedForPermission(outcome.error);
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
