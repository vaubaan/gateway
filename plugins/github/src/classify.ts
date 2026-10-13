/**
 * Classifier of the `github` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/github.md §2 (tool → slice mapping).
 *
 * Pure : no IO, no credential, no `Date`. A call returns one OR MORE slices
 * (multi-slice tools : `merge_pull_request`, `create_pull_request`,
 * `create_release`, `push_files`, file writes under `.github/workflows/`).
 * A call the plugin cannot place on the data model is `denied`, never
 * mapped to a broad slice.
 *
 * The repository is named explicitly by `owner` + `repo` and must be one of
 * the mission's GitHub resources ; the gateway checks the same thing before
 * calling (`resource-not-in-mission`), the classifier repeats it so a slice
 * never names a repository outside the mission.
 *
 * Virtual slice leaves (verbs derived from the data model, see `data-model.ts`) :
 *   - `branch[X].merge-into.W`        — secondary slice of `merge_pull_request`
 *   - `branch[X].propose-to[Y].W`     — secondary slice of `create_pull_request`
 *   - `branch[X].workflow-via-file.W` — secondary slice when a file write
 *     targets `.github/workflows/*.yml`
 *   - `branch[X].files-bulk.W`        — secondary slice of `push_files`,
 *     distinguishing a multi-file commit from a single-file write
 *
 * Concrete slices never contain wildcards : "list all <entity>" reads emit
 * the entity name without a leaf (`repo[X].branch.R`) and the catalog's
 * terminal `[**]` absorbs the missing segment.
 */

import { parseSlice, type ClassifyOutcome, type Resource, type Slice } from '@vaubaan/plugin-sdk';

const PROVIDER = 'github';

/** Tools retired by the risk-model spec §7.2 #1. Refused explicitly, even if a client still names them. */
const RETIRED_TOOLS = new Set<string>([
  'github__dispatch_workflow',
  'github__cancel_workflow_run',
  'github__rerun_workflow_run',
]);

const RETIRED_HINT = 'tool removed in v4 risk-based model — use cloud-provider tool directly';

export const MINT_TOOL = 'github__mint_install_token';

const GLOBAL_SEARCH = new Set<string>(['github__search_code', 'github__search_issues']);

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/** v5 entry point : `resources` are the mission's resources on this connection. */
export function classifyGithub(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  return classifyGithubRefs(tool, args, githubRepoRefs(resources));
}

/** The repository refs (`owner/repo`) of the GitHub resources among `resources`. */
export function githubRepoRefs(resources: readonly Resource[]): string[] {
  const out: string[] = [];
  for (const r of resources) {
    if (r.provider === PROVIDER) out.push(r.ref);
  }
  return out;
}

/**
 * Core classifier over the set of repository refs the mission may touch.
 * Shared by the v5 entry point and the legacy v4 wrapper (`risk-classifier.ts`).
 */
export function classifyGithubRefs(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  boundRepos: readonly string[],
): ClassifyOutcome {
  if (RETIRED_TOOLS.has(tool)) {
    return { denied: RETIRED_HINT };
  }

  // Global searches — not repo-scoped, so no resource lookup.
  if (GLOBAL_SEARCH.has(tool)) {
    const kind = tool === 'github__search_code' ? 'code' : 'issues';
    return { slices: [build(`${PROVIDER}.search.${kind}.R`)] };
  }

  // Credential mint — the slice depends on `purpose`, and the optional
  // `repoFullName` narrows the fan-out over the mission's repositories.
  if (tool === MINT_TOOL) {
    return classifyMintInstallToken(args, boundRepos);
  }

  // Every other tool needs `owner` + `repo` and must resolve to a resource.
  const repoRef = resolveRepoRef(args, boundRepos);
  if (typeof repoRef === 'object') return repoRef;

  switch (tool) {
    // ── Reads — code / branch / commit / file / tag ────────────────────────
    case 'github__list_branches':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].branch.R`)] };
    case 'github__list_commits': {
      const sha = strArg(args, 'sha');
      const path = sha
        ? `${PROVIDER}.repo[${repoRef}].branch[${asIdent(sha)}].commit.R`
        : `${PROVIDER}.repo[${repoRef}].commit.R`;
      return { slices: [build(path)] };
    }
    case 'github__get_file_contents': {
      const path = strArg(args, 'path');
      if (!path) return denied(tool, "requires 'path'");
      const ref = strArg(args, 'ref');
      const branchSeg = ref ? `branch[${asIdent(ref)}].` : 'branch.';
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].${branchSeg}file[${asIdent(path)}].R`)],
      };
    }
    case 'github__get_commit': {
      const sha = strArg(args, 'sha');
      if (!sha) return denied(tool, "requires 'sha'");
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].commit[${asIdent(sha)}].R`)] };
    }
    case 'github__list_tags':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].tag.R`)] };

    // ── Reads — meta (PRs, issues, comments, releases, workflows, rules) ───
    case 'github__list_pull_requests':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].pull_request.R`)] };
    case 'github__get_pull_request': {
      const n = numArg(args, 'pull_number');
      if (n == null) return denied(tool, "requires 'pull_number'");
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].pull_request[${n}].R`)] };
    }
    case 'github__list_issues':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].issue.R`)] };
    case 'github__get_issue': {
      const n = numArg(args, 'issue_number');
      if (n == null) return denied(tool, "requires 'issue_number'");
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].issue[${n}].R`)] };
    }
    case 'github__list_releases':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].release.R`)] };
    case 'github__list_workflows':
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].workflow.R`)] };
    case 'github__list_workflow_runs': {
      const wf = strArg(args, 'workflow_id') ?? numArgAsStr(args, 'workflow_id');
      const tail = wf ? `workflow[${asIdent(wf)}].workflow-run.R` : 'workflow-run.R';
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].${tail}`)] };
    }
    case 'github__get_branch_protection': {
      const branch = strArg(args, 'branch');
      if (!branch) return denied(tool, "requires 'branch'");
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].branch-protection[${asIdent(branch)}].R`)],
      };
    }

    // ── Writes — branches / files / commits ────────────────────────────────
    case 'github__create_branch': {
      const branch = strArg(args, 'branch');
      if (!branch) return denied(tool, "requires 'branch'");
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].W`)] };
    }
    case 'github__create_or_update_file':
    case 'github__delete_file': {
      const branch = strArg(args, 'branch');
      const path = strArg(args, 'path');
      if (!branch || !path) return denied(tool, "requires 'branch' and 'path'");
      return { slices: fileWriteSlices(repoRef, branch, [path]) };
    }
    case 'github__push_files': {
      const branch = strArg(args, 'branch');
      if (!branch) return denied(tool, "requires 'branch'");
      const files = readFileEntries(args);
      if (!files.length) return denied(tool, "requires non-empty 'files' array");
      const out = fileWriteSlices(
        repoRef,
        branch,
        files.map((f) => f.path),
      );
      if (files.length > 1) {
        out.push(build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].files-bulk.W`));
      }
      return { slices: dedup(out) };
    }

    // ── Writes — PRs / comments ────────────────────────────────────────────
    case 'github__create_pull_request': {
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (!head || !base) return denied(tool, "requires 'head' and 'base'");
      return {
        slices: [
          build(`${PROVIDER}.repo[${repoRef}].pull_request.W`),
          build(
            `${PROVIDER}.repo[${repoRef}].branch[${asIdent(head)}].propose-to[${asIdent(base)}].W`,
          ),
        ],
      };
    }
    case 'github__merge_pull_request': {
      const n = numArg(args, 'pull_number');
      if (n == null) return denied(tool, "requires 'pull_number'");
      // The base branch is not always in args ; assume the canonical default.
      // The catalog's `merge-protected` covers `branch[main|master|...].merge-into.W`.
      const base = strArg(args, 'base') ?? 'main';
      return {
        slices: [
          build(`${PROVIDER}.repo[${repoRef}].pull_request[${n}].W`),
          build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(base)}].merge-into.W`),
        ],
      };
    }
    case 'github__add_issue_comment': {
      const n = numArg(args, 'issue_number');
      if (n == null) return denied(tool, "requires 'issue_number'");
      // Trailing `comment` name — no leaf id (unknown before posting).
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].issue[${n}].comment.W`)] };
    }

    // ── Writes — releases ──────────────────────────────────────────────────
    case 'github__create_release': {
      const tagName = strArg(args, 'tag_name');
      if (!tagName) return denied(tool, "requires 'tag_name'");
      return {
        slices: [
          build(`${PROVIDER}.repo[${repoRef}].release.W`),
          build(`${PROVIDER}.repo[${repoRef}].tag[${asIdent(tagName)}].W`),
        ],
      };
    }
    case 'github__delete_release': {
      const id = numArg(args, 'release_id');
      if (id == null) return denied(tool, "requires 'release_id'");
      return { slices: [build(`${PROVIDER}.repo[${repoRef}].release[${id}].W`)] };
    }

    // ── Writes — rules ─────────────────────────────────────────────────────
    case 'github__update_branch_protection': {
      const branch = strArg(args, 'branch');
      if (!branch) return denied(tool, "requires 'branch'");
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].branch-protection[${asIdent(branch)}].W`)],
      };
    }

    default:
      return { denied: `unknown github tool '${tool}'` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-specific helpers
// ─────────────────────────────────────────────────────────────────────────────

/** One `file[<path>].W` slice per path, plus the `workflow-via-file` marker once a path is a workflow YAML. */
function fileWriteSlices(repoRef: string, branch: string, paths: readonly string[]): Slice[] {
  const out: Slice[] = [];
  for (const path of paths) {
    out.push(
      build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].file[${asIdent(path)}].W`),
    );
    if (isWorkflowPath(path)) {
      out.push(
        build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].workflow-via-file.W`),
      );
    }
  }
  return out;
}

function classifyMintInstallToken(
  args: Readonly<Record<string, unknown>>,
  boundRepos: readonly string[],
): ClassifyOutcome {
  const purpose = args.purpose;
  if (purpose !== 'clone' && purpose !== 'push') {
    return { denied: `${MINT_TOOL} requires purpose 'clone' or 'push'` };
  }
  const repoArg = strArg(args, 'repoFullName');
  if (repoArg) {
    if (!boundRepos.includes(repoArg)) {
      return { denied: `repo '${repoArg}' is not bound to this project` };
    }
    return { slices: [build(`${PROVIDER}.repo[${repoArg}].install-token[${purpose}].W`)] };
  }
  // No repoFullName → fan out to every repository of the mission (the same
  // set `execute` scopes the minted token to).
  if (boundRepos.length === 0) {
    return { denied: `${MINT_TOOL} requires at least one github binding on the project` };
  }
  return {
    slices: boundRepos.map((repo) =>
      build(`${PROVIDER}.repo[${repo}].install-token[${purpose}].W`),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve `<owner>/<repo>` from args and check it is one of `boundRepos`. */
function resolveRepoRef(
  args: Readonly<Record<string, unknown>>,
  boundRepos: readonly string[],
): string | { denied: string } {
  const owner = strArg(args, 'owner');
  const repo = strArg(args, 'repo');
  if (!owner || !repo) {
    return { denied: "requires string 'owner' and 'repo'" };
  }
  const ref = `${owner}/${repo}`;
  if (!boundRepos.includes(ref)) {
    return { denied: `repo '${ref}' is not bound to this project` };
  }
  return ref;
}

function strArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numArg(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numArgAsStr(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
}

export interface FileEntry {
  readonly path: string;
  readonly content: string;
}

/** The `files` argument of `push_files`, keeping only well-formed entries. */
export function readFileEntries(args: Readonly<Record<string, unknown>>): FileEntry[] {
  const raw = args.files;
  if (!Array.isArray(raw)) return [];
  const out: FileEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const path = typeof obj.path === 'string' ? obj.path : undefined;
    const content = typeof obj.content === 'string' ? obj.content : '';
    if (path && path.length > 0) out.push({ path, content });
  }
  return out;
}

/** GitHub recognizes workflow files at `.github/workflows/*.yml` and `.yaml`. */
export function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i.test(path);
}

/**
 * Render an arbitrary string as a slice bracket-ident. The DSL accepts
 * `[a-zA-Z0-9_./~*-]+` inside brackets ; characters outside that set are
 * replaced by `-` so the resulting slice still parses. Catalog patterns are
 * broad enough that the exact sanitized value rarely matters.
 */
function asIdent(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_./*~-]/g, '-');
  return cleaned.length > 0 ? cleaned : '_';
}

function denied(tool: string, message: string): { denied: string } {
  return { denied: `tool '${tool}' ${message}` };
}

/** Parse at build time so a typo in a slice template fails close to the call site. */
function build(input: string): Slice {
  return parseSlice(input);
}

function dedup(slices: readonly Slice[]): Slice[] {
  const seen = new Set<string>();
  const out: Slice[] = [];
  for (const s of slices) {
    const key = JSON.stringify({ p: s.provider, a: s.action, path: s.path });
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
