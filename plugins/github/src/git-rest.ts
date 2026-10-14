/**
 * GitHub's REST API as the git remote uses it (ADR gateway-as-git-remote
 * D4): the value of a ref, the default branch, a comparison and the paths of
 * one commit — reads, with the read grant — and the ref writes of a create
 * and a fast-forward, with the write grant.
 */
import {
  UpstreamAuthError,
  UpstreamHttpError,
  type ExecuteContext,
  type GitAccess,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import type { RepoTarget } from './call.ts';
import { gitGrant } from './git-credential.ts';

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

interface CompareFile {
  readonly filename?: string;
  readonly previous_filename?: string;
}

interface CompareDto {
  readonly status?: string;
  readonly ahead_by?: number;
  readonly total_commits?: number;
  readonly commits?: readonly { readonly sha?: string }[];
  readonly files?: readonly CompareFile[];
}

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

function pathsOf(files: readonly CompareFile[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    if (typeof f.filename === 'string') names.add(f.filename);
    if (typeof f.previous_filename === 'string') names.add(f.previous_filename);
  }
  return [...names];
}

export class GithubRest {
  private readonly tokens = new Map<GitAccess, string>();

  constructor(
    private readonly ctx: ExecuteContext,
    private readonly target: RepoTarget,
  ) {}

  private get repoPath(): string {
    return `/repos/${this.target.owner}/${this.target.repo}`;
  }

  async request(
    access: GitAccess,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let token = this.tokens.get(access);
    if (token === undefined) {
      token = (await gitGrant(this.ctx, this.target, access)).token;
      this.tokens.set(access, token);
    }
    const res = await this.ctx.fetch(`${GITHUB_API_BASE}${this.repoPath}${path}`, {
      method,
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
    });
    if (res.status === HTTP_UNAUTHORIZED) {
      await res.body?.cancel();
      throw new UpstreamAuthError('github rejected the credential (HTTP 401)', HTTP_UNAUTHORIZED);
    }
    return res;
  }

  /** The repository's default branch, or `null` for an empty repository. */
  async defaultBranch(): Promise<string | null> {
    const res = await this.request('read', 'GET', '');
    if (!res.ok)
      throw new UpstreamHttpError(`github GET /repos failed with HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' ? body.default_branch : null;
  }

  /**
   * What `ref` points at now at GitHub, or `null` when it does not exist.
   * `GET /git/ref/{ref}` answers one exact ref; anything else is "absent".
   */
  async refValue(ref: string): Promise<string | null> {
    const res = await this.request('read', 'GET', `/git/ref/${refPath(ref)}`);
    if (res.status === HTTP_NOT_FOUND || res.status === HTTP_CONFLICT) {
      // 409: an empty repository has no ref at all.
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new UpstreamHttpError(`github GET git/ref failed with HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { ref?: unknown; object?: { sha?: unknown } };
    if (body.ref !== ref || typeof body.object?.sha !== 'string') return null;
    return body.object.sha;
  }

  /** `base...head` : what `head` brings since its merge base with `base`. */
  async compare(base: string, head: string, label: string): Promise<Comparison> {
    const res = await this.request(
      'read',
      'GET',
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (res.status === HTTP_NOT_FOUND) {
      await res.body?.cancel();
      return {
        ok: false,
        reason: `${label} cannot be reviewed: it has no history in common with ${shortName(base)}`,
      };
    }
    if (!res.ok) {
      throw new UpstreamHttpError(`github compare failed with HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as CompareDto;
    const files = body.files ?? [];
    const commits = body.total_commits ?? body.ahead_by ?? 0;
    const shas = (body.commits ?? []).flatMap((c) => (typeof c.sha === 'string' ? [c.sha] : []));
    if (
      files.length >= COMPARE_MAX_FILES ||
      commits > COMPARE_MAX_COMMITS ||
      shas.length < Math.min(commits, COMPARE_MAX_COMMITS)
    ) {
      return {
        ok: false,
        reason: `${label} is too large to review (${files.length >= COMPARE_MAX_FILES ? `${COMPARE_MAX_FILES} or more files` : `more than ${COMPARE_MAX_COMMITS} commits`}); push it in smaller parts`,
        status: body.status ?? 'unknown',
        commits,
      };
    }
    return {
      ok: true,
      status: body.status ?? 'unknown',
      commits: body.ahead_by ?? commits,
      shas,
      files: pathsOf(files),
    };
  }

  /**
   * One page of the commits reachable from `sha`, newest first
   * (`GET commits?sha=`); page 1 is the first. An empty page ends the history.
   */
  async ancestors(sha: string, page: number): Promise<readonly string[]> {
    const res = await this.request(
      'read',
      'GET',
      `/commits?sha=${encodeURIComponent(sha)}&per_page=${ANCESTORS_PAGE_SIZE}&page=${page}`,
    );
    if (!res.ok) {
      throw new UpstreamHttpError(`github GET commits failed with HTTP ${res.status}`, res.status);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return (body as readonly unknown[]).flatMap((c) => {
      const sha = typeof c === 'object' && c !== null ? (c as { sha?: unknown }).sha : undefined;
      return typeof sha === 'string' ? [sha] : [];
    });
  }

  /** The paths one commit changes against its first parent; `null` when GitHub truncated the list. */
  async commitPaths(sha: string): Promise<readonly string[] | null> {
    const res = await this.request('read', 'GET', `/commits/${encodeURIComponent(sha)}`);
    if (!res.ok) {
      throw new UpstreamHttpError(`github GET commit failed with HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { files?: readonly CompareFile[] };
    const files = body.files ?? [];
    return files.length >= COMMIT_MAX_FILES ? null : pathsOf(files);
  }
}
