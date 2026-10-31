/**
 * GitHub's REST API as the git remote uses it (ADR gateway-as-git-remote
 * D4): the value of a ref, the default branch, a comparison, the paths of
 * one commit and, for the inspection before a push leaves the gateway (ADR
 * gateway-as-git-remote), one commit, tag or tree of the git
 * database — reads, with the read grant — and the ref writes of a create and
 * a fast-forward, with the write grant.
 *
 * Every read goes through `httpJson` and is read field by field with type
 * checks : a field of the wrong type is "not said", as GitHub leaving it
 * out would be ; an answer that is not JSON, or not an object (a list for
 * `commits`), is GitHub's failure (`UpstreamProtocolError`). 401 and 403
 * are `UpstreamAuthError`.
 */
import {
  UpstreamAuthError,
  UpstreamHttpError,
  httpJson,
  isList,
  isRecord,
  type ExecuteContext,
  type Guard,
} from '@vaubaan/plugin-sdk';
import { normalizeMode, type GitTreeEntry } from '@vaubaan/plugin-sdk/git';

import { GITHUB_API_BASE, githubApiHeaders } from './api.ts';
import type { RepoTarget } from './call.ts';
import { githubTokenOf } from './credential.ts';

/** GitHub's compare API lists at most this many files ; a longer list is truncated. */
export const COMPARE_MAX_FILES = 300;
/** GitHub's compare API lists at most this many commits. */
export const COMPARE_MAX_COMMITS = 250;
/** GitHub lists at most this many files of one commit on one page. */
export const COMMIT_MAX_FILES = 300;

export const HTTP_UNAUTHORIZED = 401;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
/** GitHub's answer to a ref write it refuses (not a fast-forward, already exists). */
export const HTTP_UNPROCESSABLE = 422;

export type Comparison =
  | {
      readonly ok: true;
      readonly status: string;
      readonly commits: number;
      /** The commits `head` brings, as GitHub lists them. */
      readonly shas: readonly string[];
      readonly files: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** GitHub's status when the comparison exists but is too large to review. */
      readonly status?: string;
      /** How many commits `head` brings, when GitHub said. */
      readonly commits?: number;
    };

/** An object read through GitHub's git database API. */
export type GitObjectRead =
  | {
      readonly kind: 'commit';
      readonly tree: string;
      readonly parents: readonly string[];
    }
  | { readonly kind: 'tag'; readonly object: string; readonly type: string };

/** GitHub's answers for an object it does not hold (404) or an id it rejects (422). */
const OBJECT_ABSENT = [HTTP_NOT_FOUND, HTTP_UNPROCESSABLE] as const;

/** Commits of one page of `GET commits?sha=` (GitHub's maximum). */
export const ANCESTORS_PAGE_SIZE = 100;

/** `heads/feature/x` with every segment URL-encoded. */
export function refPath(ref: string): string {
  return ref
    .replace(/^refs\//, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function shortName(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

/** The elements of `value` when it is a list, none otherwise : a list GitHub left out is empty. */
function listOf(value: unknown): readonly unknown[] {
  return isList(value) ? value : [];
}

/** The `sha` of each element that has one as a string : commits, parents. */
function shasOf(value: unknown): string[] {
  return listOf(value).flatMap((c) => (isRecord(c) && typeof c.sha === 'string' ? [c.sha] : []));
}

/** `sha` of a nested object (`tree`, `object`), when it is a string. */
function nestedSha(value: unknown): string | undefined {
  return isRecord(value) && typeof value.sha === 'string' ? value.sha : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** The paths a list of changed files names, renamed files under both names. */
function pathsOf(files: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    if (!isRecord(f)) continue;
    if (typeof f.filename === 'string') names.add(f.filename);
    if (typeof f.previous_filename === 'string') names.add(f.previous_filename);
  }
  return [...names];
}

export class GithubRest {
  constructor(
    private readonly ctx: ExecuteContext,
    private readonly target: RepoTarget,
  ) {}

  private url(path: string): string {
    return `${GITHUB_API_BASE}/repos/${this.target.owner}/${this.target.repo}${path}`;
  }

  /**
   * A ref write (`git-moves.ts`) : GitHub's answer as it is, for its status
   * and message to say which ref was refused and why. A 401 is the rejected
   * credential.
   */
  async write(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<Response> {
    const res = await this.ctx.fetch(this.url(path), {
      method,
      headers: { ...githubApiHeaders(githubTokenOf(this.ctx)), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
    });
    if (res.status === HTTP_UNAUTHORIZED) {
      await res.body?.cancel();
      throw new UpstreamAuthError('github rejected the credential (HTTP 401)', HTTP_UNAUTHORIZED);
    }
    return res;
  }

  /** One read of the repository's API, its answer through `guard`. */
  private read<T>(path: string, what: string, guard: Guard<T>): Promise<T> {
    const headers = githubApiHeaders(githubTokenOf(this.ctx));
    return httpJson(this.ctx, { url: this.url(path), headers, what }, guard);
  }

  /**
   * `read`, or `null` when GitHub answers one of the `absent` statuses : the
   * object, or the ref, is not there.
   */
  private async readUnlessAbsent<T>(
    path: string,
    what: string,
    guard: Guard<T>,
    absent: readonly number[],
  ): Promise<T | null> {
    try {
      return await this.read(path, what, guard);
    } catch (error) {
      if (error instanceof UpstreamHttpError && absent.includes(error.status)) return null;
      throw error;
    }
  }

  /** The repository's default branch, or `null` for an empty repository. */
  async defaultBranch(): Promise<string | null> {
    const repository = await this.read('', 'github GET /repos', isRecord);
    return typeof repository.default_branch === 'string' ? repository.default_branch : null;
  }

  /**
   * What `ref` points at now at GitHub, or `null` when it does not exist.
   * `GET /git/ref/{ref}` answers one exact ref; anything else is "absent".
   * 409: an empty repository has no ref at all.
   */
  async refValue(ref: string): Promise<string | null> {
    const answer = await this.readUnlessAbsent(
      `/git/ref/${refPath(ref)}`,
      'github GET git/ref',
      isRecord,
      [HTTP_NOT_FOUND, HTTP_CONFLICT],
    );
    if (answer === null || answer.ref !== ref) return null;
    return nestedSha(answer.object) ?? null;
  }

  /** `base...head` : what `head` brings since its merge base with `base`. */
  async compare(base: string, head: string, label: string): Promise<Comparison> {
    const answer = await this.readUnlessAbsent(
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      'github compare',
      isRecord,
      [HTTP_NOT_FOUND],
    );
    if (answer === null) {
      return {
        ok: false,
        reason: `${label} cannot be reviewed: it has no history in common with ${shortName(base)}`,
      };
    }
    const files = listOf(answer.files);
    const aheadBy = typeof answer.ahead_by === 'number' ? answer.ahead_by : undefined;
    const commits = numberOr(answer.total_commits, aheadBy ?? 0);
    const shas = shasOf(answer.commits);
    const status = typeof answer.status === 'string' ? answer.status : 'unknown';
    if (
      files.length >= COMPARE_MAX_FILES ||
      commits > COMPARE_MAX_COMMITS ||
      shas.length < Math.min(commits, COMPARE_MAX_COMMITS)
    ) {
      return {
        ok: false,
        reason: `${label} is too large to review (${files.length >= COMPARE_MAX_FILES ? `${COMPARE_MAX_FILES} or more files` : `more than ${COMPARE_MAX_COMMITS} commits`}); push it in smaller parts`,
        status,
        commits,
      };
    }
    return { ok: true, status, commits: aheadBy ?? commits, shas, files: pathsOf(files) };
  }

  /**
   * One page of the commits reachable from `sha`, newest first
   * (`GET commits?sha=`); page 1 is the first. An empty page ends the history.
   */
  async ancestors(sha: string, page: number): Promise<readonly string[]> {
    const listed = await this.read(
      `/commits?sha=${encodeURIComponent(sha)}&per_page=${ANCESTORS_PAGE_SIZE}&page=${page}`,
      'github GET commits',
      isList,
    );
    return shasOf(listed);
  }

  /**
   * A commit's tree and parents, or an annotated tag's target, as GitHub
   * holds the object (`GET git/commits/{sha}`, then `GET git/tags/{sha}`);
   * `null` when GitHub holds neither under this id.
   */
  async gitObject(sha: string): Promise<GitObjectRead | null> {
    const id = encodeURIComponent(sha);
    const commit = await this.readUnlessAbsent(
      `/git/commits/${id}`,
      'github GET git/commits',
      isRecord,
      OBJECT_ABSENT,
    );
    if (commit !== null) {
      const tree = nestedSha(commit.tree);
      if (commit.sha !== sha || tree === undefined) return null;
      return { kind: 'commit', tree, parents: shasOf(commit.parents) };
    }
    const tag = await this.readUnlessAbsent(
      `/git/tags/${id}`,
      'github GET git/tags',
      isRecord,
      OBJECT_ABSENT,
    );
    if (tag === null || tag.sha !== sha || !isRecord(tag.object)) return null;
    const { sha: object, type } = tag.object;
    if (typeof object !== 'string') return null;
    return { kind: 'tag', object, type: typeof type === 'string' ? type : 'unknown' };
  }

  /**
   * The entries of one tree (`GET git/trees/{sha}`, not recursive), modes as
   * git writes them in a tree object; `null` when GitHub holds no such tree
   * or truncated its listing.
   */
  async gitTree(sha: string): Promise<readonly GitTreeEntry[] | null> {
    const answer = await this.readUnlessAbsent(
      `/git/trees/${encodeURIComponent(sha)}`,
      'github GET git/trees',
      isRecord,
      OBJECT_ABSENT,
    );
    if (answer === null || answer.sha !== sha || answer.truncated === true) return null;
    if (!isList(answer.tree)) return null;
    const entries: GitTreeEntry[] = [];
    for (const e of answer.tree) {
      if (
        !isRecord(e) ||
        typeof e.path !== 'string' ||
        typeof e.mode !== 'string' ||
        typeof e.sha !== 'string'
      ) {
        return null;
      }
      entries.push({ name: e.path, mode: normalizeMode(e.mode), oid: e.sha });
    }
    return entries;
  }

  /** The paths one commit changes against its first parent; `null` when GitHub truncated the list. */
  async commitPaths(sha: string): Promise<readonly string[] | null> {
    const commit = await this.read(
      `/commits/${encodeURIComponent(sha)}`,
      'github GET commit',
      isRecord,
    );
    const files = listOf(commit.files);
    return files.length >= COMMIT_MAX_FILES ? null : pathsOf(files);
  }
}
