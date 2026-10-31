/**
 * Arguments of the `github` provider : the grammars of every identifier and
 * the one reader, `readGithubCall`, that `classify` and `execute` share.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`.
 *
 * What is classified must be what is sent. An identifier of a call — the
 * repository, a branch, a file path, a revision, a number — lands in a slice
 * **and** in a request (path, query string or body). Both sides therefore
 * take it from the `GithubCall` this module builds, never from the raw
 * arguments : `classify.ts` turns the call into slices, `octokit-dispatch.ts`
 * into requests. A value outside its grammar refuses the call ; nothing is
 * repaired, trimmed or defaulted on one side only.
 *
 * Why a grammar per kind and not an escape : Octokit expands a path
 * parameter with `encodeURIComponent`, which leaves `.` and `..` untouched,
 * and every URL parser then removes those segments — `/contents/..` is sent
 * as the repository endpoint, `/actions/workflows/../runs` as the runs of
 * every workflow. Each grammar below makes a dot-only segment impossible ;
 * separators and everything else are percent-encoded by Octokit.
 */

import { isList, type Resource } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, RETIRED_TOOL, TOOL } from './identity.ts';

/** Tools retired by the risk-model spec §7.2 #1. Refused explicitly, even if a client still names them. */
const RETIRED_TOOLS: ReadonlySet<string> = new Set(Object.values(RETIRED_TOOL));

const RETIRED_HINT =
  'tool retired: this gateway does not dispatch, cancel or re-run GitHub workflows — use the deployment tools of the provider that hosts the service.';

/** The branch `merge_pull_request` is classified on when the call declares no `base`. */
export const DEFAULT_MERGE_BASE = 'main';

/** Refusal when the mission holds no GitHub repository at all. */
export const NO_REPOSITORY_SELECTED = 'no GitHub repository is selected in this mission.';

/** Up to this many repositories a refusal names them ; above, it gives their count. */
const MAX_REPOSITORIES_NAMED_IN_REFUSAL = 5;

/** Longest value a refusal quotes back. */
const MAX_QUOTED_LENGTH = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Grammars — one function per kind of identifier
// ─────────────────────────────────────────────────────────────────────────────

/** Longest file path accepted (characters). */
export const MAX_PATH_LENGTH = 4096;
/** Longest branch, tag or revision accepted (characters). */
export const MAX_GIT_NAME_LENGTH = 255;
/** Longest workflow file name accepted (characters). */
export const MAX_FILE_NAME_LENGTH = 255;

/** A user or organisation login ; `_` appears in enterprise-managed logins. */
const OWNER_NAME = /^[A-Za-z0-9_-]{1,39}$/;
/** A repository name : `my.repo` and `.github` are names, `.` and `..` are not. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Control characters, unpaired surrogates and line separators : in no name, no path. */
const UNPRINTABLE = /[\p{Cc}\p{Cs}\u2028\u2029]/u;
/** What no git name holds : the above, any blank, an invisible format character, `: ? * [ \`. */
const GIT_NAME_FORBIDDEN = /[\p{Cc}\p{Cs}\p{Cf}\p{Z}:?*[\\]/u;
/** Revision operators : fine in a revision that is read (`HEAD~2`), never part of a branch or tag name. */
const REVISION_OPERATOR = /[~^]/;

/** The owner of a repository, or `null`. */
export function ownerName(value: unknown): string | null {
  return typeof value === 'string' && OWNER_NAME.test(value) ? value : null;
}

/** The name of a repository (no owner), or `null`. */
export function repoName(value: unknown): string | null {
  if (typeof value !== 'string' || !REPO_NAME.test(value)) return null;
  return value === '.' || value === '..' ? null : value;
}

export interface RepoTarget {
  readonly owner: string;
  /** Repository name, without owner. */
  readonly repo: string;
  /** `owner/repo` — the resource ref, and the first bracket of every slice. */
  readonly ref: string;
}

/** `owner/repo` with exactly one separator and two well-formed names, or `null`. */
export function repoFullName(value: unknown): RepoTarget | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash === -1) return null;
  const owner = ownerName(value.slice(0, slash));
  const repo = repoName(value.slice(slash + 1));
  return owner !== null && repo !== null ? { owner, repo, ref: value } : null;
}

/**
 * A file path of a repository in the one spelling the classifier reasons
 * about : relative, `/`-separated, with no empty, `.` or `..` segment, no
 * backslash and no control character. Any other spelling is refused rather
 * than normalised, so neither `isWorkflowPath` nor the request path depends
 * on how GitHub — or a URL parser — would resolve it.
 */
export function repoPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return null;
  }
  if (value.includes('\\') || UNPRINTABLE.test(value)) return null;
  return value.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..') ? value : null;
}

/**
 * A revision GitHub resolves for a read : a branch, a tag, a full ref
 * (`refs/tags/v1`), a commit SHA, or one of those with `~N` / `^N`. The rules
 * are those of `git check-ref-format` : `/`-separated components, none empty,
 * none starting with a dot or ending in `.lock`, no `..`, no `@{`, no blank
 * or control character. A component can therefore never be `.` or `..`.
 */
export function revision(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GIT_NAME_LENGTH) {
    return null;
  }
  if (GIT_NAME_FORBIDDEN.test(value)) return null;
  if (value === '@' || value.includes('..') || value.includes('@{')) return null;
  if (value.startsWith('-') || value.endsWith('.')) return null;
  const wellFormed = value
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
  return wellFormed ? value : null;
}

/**
 * Every path under `.github/workflows/`: GitHub asks the `workflows`
 * permission for any change there, nested or not, whatever the extension.
 */
export const WORKFLOW_DIRECTORY = /^\.github\/workflows\//i;

/** A change under `.github/workflows/` (what the git remote counts as a workflow change). */
export function isUnderWorkflowDirectory(path: string): boolean {
  return WORKFLOW_DIRECTORY.test(path);
}

/** GitHub recognizes workflow files at `.github/workflows/*.yml` and `.yaml`. */
export function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i.test(path);
}

/** A name git accepts for a ref : a revision without revision operators. */
function refName(value: unknown): string | null {
  const name = revision(value);
  return name !== null && !REVISION_OPERATOR.test(name) ? name : null;
}

/** `refs/heads/main` or `heads/main` : a ref, where a branch name is expected. */
function isRefSpelling(name: string): boolean {
  return name.startsWith('refs/') || name.startsWith('heads/');
}

/**
 * A branch name, not a ref : `refs/heads/main` or `heads/main` could reach
 * `main` under a spelling the protected-branch patterns do not match.
 */
export function branchName(value: unknown): string | null {
  const name = refName(value);
  return name !== null && !isRefSpelling(name) ? name : null;
}

/** A tag name, not a ref (`v1.2.3`, never `refs/tags/v1.2.3`). */
export function tagName(value: unknown): string | null {
  const name = refName(value);
  return name !== null && !name.startsWith('refs/') ? name : null;
}

/** The head of a pull request : a branch of the repository, or `owner:branch` for a fork. */
export function pullRequestHead(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const colon = value.indexOf(':');
  if (colon === -1) return branchName(value);
  const wellFormed =
    ownerName(value.slice(0, colon)) !== null && branchName(value.slice(colon + 1)) !== null;
  return wellFormed ? value : null;
}

/** The number of a pull request, an issue or a release : a positive integer. */
export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A workflow, by numeric id or by file name (`ci.yml`). The name is one path
 * segment : no separator, not `.` or `..`, no control character.
 */
export function workflowRef(value: unknown): string | number | null {
  if (typeof value === 'number') return positiveInteger(value);
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_NAME_LENGTH) {
    return null;
  }
  if (value === '.' || value === '..') return null;
  return /[/\\]/.test(value) || UNPRINTABLE.test(value) ? null : value;
}

/** Default of `max_bytes` on `get_job_logs` : 64 KiB, enough for the end of a failed step. */
export const JOB_LOG_DEFAULT_BYTES = 64 * 1024;
/** Most bytes of a job log one call returns (1 MiB). */
export const JOB_LOG_MAX_BYTES = 1024 * 1024;

/** `max_bytes` of `get_job_logs` : an integer from 1 to `JOB_LOG_MAX_BYTES`, or `null`. */
export function logByteCount(value: unknown): number | null {
  const n = positiveInteger(value);
  return n !== null && n <= JOB_LOG_MAX_BYTES ? n : null;
}

/** The `filter` of `list_workflow_jobs` : the latest attempt of the run, or every attempt. */
export type JobFilter = 'latest' | 'all';

function jobFilter(value: unknown): JobFilter | null {
  return value === 'latest' || value === 'all' ? value : null;
}

export interface FileEntry {
  readonly path: string;
  readonly content: string;
}

/** What `push_files` requires of its `files` argument, as worded in refusals. */
export const FILES_SHAPE = "'files' to be a non-empty array of { path, content } strings";

/**
 * The `files` argument of `push_files`, or `undefined` unless it is a
 * non-empty array whose every entry has a string `path` and a string
 * `content`.
 */
function readFileEntries(args: Readonly<Record<string, unknown>>): FileEntry[] | undefined {
  const raw: unknown = args.files;
  if (!isList(raw) || raw.length === 0) return undefined;
  const out: FileEntry[] = [];
  for (const item of raw) {
    if (!isFileEntry(item)) return undefined;
    out.push({ path: item.path, content: item.content });
  }
  return out;
}

function isFileEntry(item: unknown): item is FileEntry {
  if (item === null || typeof item !== 'object') return false;
  const path: unknown = 'path' in item ? item.path : undefined;
  const content: unknown = 'content' in item ? item.content : undefined;
  return typeof path === 'string' && path.length > 0 && typeof content === 'string';
}

// ─────────────────────────────────────────────────────────────────────────────
// The call — what `classify` turns into slices and `execute` into requests
// ─────────────────────────────────────────────────────────────────────────────

/** A repository-scoped call : `target` is one of the mission's repositories. */
export type RepoCall = { readonly target: RepoTarget } & (
  | {
      readonly tool:
        | typeof TOOL.listBranches
        | typeof TOOL.listTags
        | typeof TOOL.listPullRequests
        | typeof TOOL.listIssues
        | typeof TOOL.listReleases
        | typeof TOOL.listWorkflows;
    }
  | { readonly tool: typeof TOOL.listCommits; readonly sha: string | undefined }
  | {
      readonly tool: typeof TOOL.getFileContents;
      readonly path: string;
      readonly ref: string | undefined;
    }
  | { readonly tool: typeof TOOL.getCommit; readonly sha: string }
  | {
      readonly tool: typeof TOOL.getPullRequest;
      readonly pullNumber: number;
    }
  | {
      readonly tool: typeof TOOL.getIssue | typeof TOOL.addIssueComment;
      readonly issueNumber: number;
    }
  | {
      readonly tool: typeof TOOL.listWorkflowRuns;
      readonly workflowId: string | number | undefined;
      /** Filter of the listing, sent in the query string ; not a slice segment. */
      readonly branch: string | undefined;
    }
  | {
      readonly tool: typeof TOOL.listWorkflowJobs;
      readonly runId: number;
      /** Which attempts of the run, sent in the query string ; not a slice segment. */
      readonly filter: JobFilter | undefined;
    }
  | {
      readonly tool: typeof TOOL.getJobLogs;
      readonly jobId: number;
      /** Most bytes of the log returned. */
      readonly maxBytes: number;
      /** Keep the end of the log rather than its beginning. */
      readonly tail: boolean;
    }
  | {
      readonly tool: typeof TOOL.getBranchProtection | typeof TOOL.updateBranchProtection;
      readonly branch: string;
    }
  | {
      readonly tool: typeof TOOL.createBranch;
      readonly branch: string;
      /** The branch to start from ; the repository's default branch when absent. */
      readonly fromBranch: string | undefined;
    }
  | {
      readonly tool: typeof TOOL.createOrUpdateFile | typeof TOOL.deleteFile;
      readonly branch: string;
      readonly path: string;
    }
  | {
      readonly tool: typeof TOOL.pushFiles;
      readonly branch: string;
      readonly files: readonly FileEntry[];
    }
  | {
      readonly tool: typeof TOOL.createPullRequest;
      readonly head: string;
      readonly base: string;
    }
  | {
      readonly tool: typeof TOOL.mergePullRequest;
      readonly pullNumber: number;
      /** The declared base : classified on, then compared with the pull request's real base. */
      readonly base: string;
    }
  | {
      readonly tool: typeof TOOL.createRelease;
      readonly tagName: string;
      /** Where a new tag is put ; not a slice segment. */
      readonly targetCommitish: string | undefined;
    }
  | { readonly tool: typeof TOOL.deleteRelease; readonly releaseId: number }
);

export type GithubCall =
  /** Account-shaped : not bound to a repository of the mission. */
  { readonly tool: typeof TOOL.searchCode | typeof TOOL.searchIssues } | RepoCall;

export interface Denied {
  readonly denied: string;
}

/** The repository refs (`owner/repo`) of the GitHub resources among `resources`. */
export function githubRepoRefs(resources: readonly Resource[]): string[] {
  const out: string[] = [];
  for (const r of resources) {
    if (r.provider === PROVIDER_ID) out.push(r.ref);
  }
  return out;
}

/**
 * Refusal for a repository that is not one of the mission's. Names the
 * selected repositories when they are few, so the agent can correct the call.
 */
export function repositoryNotSelectedMessage(ref: string, missionRepos: readonly string[]): string {
  if (missionRepos.length === 0) return NO_REPOSITORY_SELECTED;
  const selected =
    missionRepos.length <= MAX_REPOSITORIES_NAMED_IN_REFUSAL
      ? `Selected: ${missionRepos.join(', ')}.`
      : `${missionRepos.length} repositories are selected.`;
  return `github repository '${quoted(ref)}' is not selected in this mission. ${selected}`;
}

/**
 * Read the arguments of one tool call against the repositories of the
 * mission (`owner/repo` refs). Returns the call with every identifier checked
 * by its grammar, or the refusal. `classify` and `execute` both start here.
 */
export function readGithubCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  missionRepos: readonly string[],
): GithubCall | Denied {
  if (RETIRED_TOOLS.has(tool)) return { denied: RETIRED_HINT };

  // Global searches — not repo-scoped, so no resource lookup.
  if (tool === TOOL.searchCode || tool === TOOL.searchIssues) return { tool };

  // Every other tool needs `owner` + `repo` and must resolve to a resource.
  const target = resolveRepo(args, missionRepos);
  if ('denied' in target) return target;

  switch (tool) {
    case TOOL.listBranches:
    case TOOL.listTags:
    case TOOL.listPullRequests:
    case TOOL.listIssues:
    case TOOL.listReleases:
    case TOOL.listWorkflows:
      return { tool, target };

    case TOOL.listCommits: {
      const sha = optional(args.sha, revision);
      if (sha === null) return denied(tool, notARevision('sha', args.sha));
      return { tool, target, sha };
    }
    case TOOL.getFileContents: {
      if (!isGiven(args.path)) return denied(tool, "requires 'path'");
      const path = repoPath(args.path);
      if (path === null) return denied(tool, notACanonicalPath(args.path));
      const ref = optional(args.ref, revision);
      if (ref === null) return denied(tool, notARevision('ref', args.ref));
      return { tool, target, path, ref };
    }
    case TOOL.getCommit: {
      if (!isGiven(args.sha)) return denied(tool, "requires 'sha'");
      const sha = revision(args.sha);
      if (sha === null) return denied(tool, notARevision('sha', args.sha));
      return { tool, target, sha };
    }
    case TOOL.getPullRequest: {
      const pullNumber = positiveInteger(args.pull_number);
      if (pullNumber === null) return denied(tool, "requires 'pull_number'");
      return { tool, target, pullNumber };
    }
    case TOOL.getIssue:
    case TOOL.addIssueComment: {
      const issueNumber = positiveInteger(args.issue_number);
      if (issueNumber === null) return denied(tool, "requires 'issue_number'");
      return { tool, target, issueNumber };
    }
    case TOOL.listWorkflowRuns: {
      const workflowId = optional(args.workflow_id, workflowRef);
      if (workflowId === null) {
        return denied(tool, "'workflow_id' must be a workflow id or a workflow file name");
      }
      const branch = optional(args.branch, branchName);
      if (branch === null) return denied(tool, notABranch(args.branch));
      return { tool, target, workflowId, branch };
    }
    case TOOL.listWorkflowJobs: {
      const runId = positiveInteger(args.run_id);
      if (runId === null) return denied(tool, "requires 'run_id', a positive integer");
      const filter = optional(args.filter, jobFilter);
      if (filter === null) return denied(tool, "'filter' must be 'latest' or 'all'");
      return { tool, target, runId, filter };
    }
    case TOOL.getJobLogs: {
      const jobId = positiveInteger(args.job_id);
      if (jobId === null) return denied(tool, "requires 'job_id', a positive integer");
      const maxBytes = optional(args.max_bytes, logByteCount);
      if (maxBytes === null) {
        return denied(tool, `'max_bytes' must be an integer from 1 to ${JOB_LOG_MAX_BYTES}`);
      }
      const tail = optional(args.tail, (v) => (typeof v === 'boolean' ? v : null));
      if (tail === null) return denied(tool, "'tail' must be true or false");
      return {
        tool,
        target,
        jobId,
        maxBytes: maxBytes ?? JOB_LOG_DEFAULT_BYTES,
        tail: tail ?? false,
      };
    }
    case TOOL.getBranchProtection:
    case TOOL.updateBranchProtection: {
      if (!isGiven(args.branch)) return denied(tool, "requires 'branch'");
      const branch = branchName(args.branch);
      if (branch === null) return denied(tool, notABranch(args.branch));
      return { tool, target, branch };
    }
    case TOOL.createBranch: {
      if (!isGiven(args.branch)) return denied(tool, "requires 'branch'");
      const branch = branchName(args.branch);
      if (branch === null) return denied(tool, notABranch(args.branch));
      const fromBranch = optional(args.from_branch, branchName);
      if (fromBranch === null) return denied(tool, notABranch(args.from_branch));
      return { tool, target, branch, fromBranch };
    }
    case TOOL.createOrUpdateFile:
    case TOOL.deleteFile: {
      if (!isGiven(args.branch) || !isGiven(args.path)) {
        return denied(tool, "requires 'branch' and 'path'");
      }
      const branch = branchName(args.branch);
      if (branch === null) return denied(tool, notABranch(args.branch));
      const path = repoPath(args.path);
      if (path === null) return denied(tool, notACanonicalPath(args.path));
      return { tool, target, branch, path };
    }
    case TOOL.pushFiles: {
      if (!isGiven(args.branch)) return denied(tool, "requires 'branch'");
      const branch = branchName(args.branch);
      if (branch === null) return denied(tool, notABranch(args.branch));
      const files = readFileEntries(args);
      if (!files) return denied(tool, `requires ${FILES_SHAPE}`);
      const badPath = files.find((f) => repoPath(f.path) === null);
      if (badPath !== undefined) return denied(tool, notACanonicalPath(badPath.path));
      return { tool, target, branch, files };
    }
    case TOOL.createPullRequest: {
      if (!isGiven(args.head) || !isGiven(args.base)) {
        return denied(tool, "requires 'head' and 'base'");
      }
      const head = pullRequestHead(args.head);
      if (head === null) {
        return denied(tool, `head '${quoted(args.head)}' must be 'branch' or 'owner:branch'`);
      }
      const base = branchName(args.base);
      if (base === null) return denied(tool, notABranch(args.base));
      return { tool, target, head, base };
    }
    case TOOL.mergePullRequest: {
      const pullNumber = positiveInteger(args.pull_number);
      if (pullNumber === null) return denied(tool, "requires 'pull_number'");
      // The declared base selects the risk class (`merge-protected` covers
      // `branch[main|master|...].merge-into.W`) ; GitHub never receives it, so
      // the dispatcher reads the pull request and refuses the merge when its
      // real base is another branch.
      const base = optional(args.base, branchName);
      if (base === null) return denied(tool, notABranch(args.base));
      return { tool, target, pullNumber, base: base ?? DEFAULT_MERGE_BASE };
    }
    case TOOL.createRelease: {
      if (!isGiven(args.tag_name)) return denied(tool, "requires 'tag_name'");
      const tag = tagName(args.tag_name);
      if (tag === null) {
        return denied(tool, `tag_name '${quoted(args.tag_name)}' is not a tag name`);
      }
      const targetCommitish = optional(args.target_commitish, revision);
      if (targetCommitish === null) {
        return denied(tool, notARevision('target_commitish', args.target_commitish));
      }
      return { tool, target, tagName: tag, targetCommitish };
    }
    case TOOL.deleteRelease: {
      const releaseId = positiveInteger(args.release_id);
      if (releaseId === null) return denied(tool, "requires 'release_id'");
      return { tool, target, releaseId };
    }
    default:
      return { denied: `unknown github tool '${tool}'` };
  }
}

/**
 * `owner` + `repo` as one of the mission's repositories. Both must be
 * well-formed names on their own : `owner: 'a/b', repo: 'c'` never stands for
 * a resource `a/b/c`, and neither can hold a dot segment.
 */
function resolveRepo(
  args: Readonly<Record<string, unknown>>,
  missionRepos: readonly string[],
): RepoTarget | Denied {
  const { owner, repo } = args;
  if (typeof owner !== 'string' || owner === '' || typeof repo !== 'string' || repo === '') {
    return { denied: "requires string 'owner' and 'repo'" };
  }
  const ref = `${owner}/${repo}`;
  if (ownerName(owner) === null || repoName(repo) === null || !missionRepos.includes(ref)) {
    return { denied: repositoryNotSelectedMessage(ref, missionRepos) };
  }
  return { owner, repo, ref };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** An argument the caller filled in : `undefined`, `null` and `''` all mean "not given". */
function isGiven(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * An optional identifier : `undefined` when not given, the checked value when
 * it fits its grammar, `null` when it was given and does not. A value of the
 * wrong type is not "absent" : it is refused.
 */
function optional<T>(value: unknown, grammar: (value: unknown) => T | null): T | undefined | null {
  return isGiven(value) ? grammar(value) : undefined;
}

/** A refused value as a refusal quotes it : bounded, printable. */
function quoted(value: unknown): string {
  if (typeof value !== 'string') return `<${typeof value}>`;
  const printable = value.replace(/[\p{Cc}\p{Cs}\u2028\u2029]/gu, '?');
  return printable.length > MAX_QUOTED_LENGTH
    ? `${printable.slice(0, MAX_QUOTED_LENGTH)}…`
    : printable;
}

function notACanonicalPath(path: unknown): string {
  return `path '${quoted(path)}' must be relative, with no empty, '.' or '..' segment and no backslash`;
}

function notABranch(branch: unknown): string {
  if (typeof branch === 'string' && isRefSpelling(branch) && refName(branch) !== null) {
    return `branch '${quoted(branch)}' must be a branch name such as 'main', not a ref`;
  }
  return `branch '${quoted(branch)}' is not a branch name`;
}

function notARevision(key: string, value: unknown): string {
  return `${key} '${quoted(value)}' is not a branch, a tag or a commit`;
}

function denied(tool: string, message: string): Denied {
  return { denied: `tool '${tool}' ${message}` };
}
