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
 * The arguments are read once, by `readGithubCall` (`call.ts`) : every
 * identifier is checked by its grammar there, and the slices below are built
 * from the same `GithubCall` the dispatcher sends (`octokit-dispatch.ts`).
 * What selects a risk class is therefore either sent to GitHub as it was
 * classified or verified against GitHub : file paths must be canonical and
 * branches must be branch names (refused otherwise, so the
 * `.github/workflows/` and protected-branch patterns cannot be dodged by
 * another spelling), and the declared base of `merge_pull_request` is
 * compared with the pull request's real base before the merge.
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
 * terminal `[**]` absorbs the missing segment. A branch or a revision cannot
 * hold a `*` (its grammar refuses it) ; in a file path, where `*` is an
 * ordinary character, it is replaced like any character outside the ident
 * class (`asIdent`).
 */

import { parseSlice, type ClassifyOutcome, type Resource, type Slice } from '@vaubaan/plugin-sdk';

import { MINT_TOOL, PROVIDER, githubRepoRefs, readGithubCall, type GithubCall } from './call.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/** Entry point : `resources` are the mission's resources on this connection. */
export function classifyGithub(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const call = readGithubCall(tool, args, githubRepoRefs(resources));
  if ('denied' in call) return call;
  return { slices: slicesOf(call) };
}

/** The slices of a call whose identifiers `readGithubCall` has checked. */
export function slicesOf(call: GithubCall): Slice[] {
  switch (call.tool) {
    // ── Global searches — not repo-scoped ──────────────────────────────────
    case 'github__search_code':
      return [build(`${PROVIDER}.search.code.R`)];
    case 'github__search_issues':
      return [build(`${PROVIDER}.search.issues.R`)];

    // ── Credential mint — one slice per repository the token is scoped to ──
    case MINT_TOOL:
      return call.repositories.map((repo) =>
        build(`${PROVIDER}.repo[${repo.ref}].install-token[${call.purpose}].W`),
      );
    default:
      return repoSlices(call);
  }
}

function repoSlices(call: Extract<GithubCall, { target: unknown }>): Slice[] {
  const repo = `${PROVIDER}.repo[${call.target.ref}]`;
  switch (call.tool) {
    // ── Reads — code / branch / commit / file / tag ────────────────────────
    case 'github__list_branches':
      return [build(`${repo}.branch.R`)];
    case 'github__list_commits':
      return [
        build(
          call.sha !== undefined
            ? `${repo}.branch[${asIdent(call.sha)}].commit.R`
            : `${repo}.commit.R`,
        ),
      ];
    case 'github__get_file_contents': {
      const branchSeg = call.ref !== undefined ? `branch[${asIdent(call.ref)}].` : 'branch.';
      return [build(`${repo}.${branchSeg}file[${asIdent(call.path)}].R`)];
    }
    case 'github__get_commit':
      return [build(`${repo}.commit[${asIdent(call.sha)}].R`)];
    case 'github__list_tags':
      return [build(`${repo}.tag.R`)];

    // ── Reads — meta (PRs, issues, comments, releases, workflows, rules) ───
    case 'github__list_pull_requests':
      return [build(`${repo}.pull_request.R`)];
    case 'github__get_pull_request':
      return [build(`${repo}.pull_request[${call.pullNumber}].R`)];
    case 'github__list_issues':
      return [build(`${repo}.issue.R`)];
    case 'github__get_issue':
      return [build(`${repo}.issue[${call.issueNumber}].R`)];
    case 'github__list_releases':
      return [build(`${repo}.release.R`)];
    case 'github__list_workflows':
      return [build(`${repo}.workflow.R`)];
    case 'github__list_workflow_runs': {
      const tail =
        call.workflowId !== undefined
          ? `workflow[${asIdent(String(call.workflowId))}].workflow-run.R`
          : 'workflow-run.R';
      return [build(`${repo}.${tail}`)];
    }
    case 'github__get_branch_protection':
      return [build(`${repo}.branch-protection[${asIdent(call.branch)}].R`)];

    // ── Writes — branches / files / commits ────────────────────────────────
    case 'github__create_branch':
      return [build(`${repo}.branch[${asIdent(call.branch)}].W`)];
    case 'github__create_or_update_file':
    case 'github__delete_file':
      return fileWriteSlices(repo, call.branch, [call.path]);
    case 'github__push_files': {
      const out = fileWriteSlices(
        repo,
        call.branch,
        call.files.map((f) => f.path),
      );
      if (call.files.length > 1) {
        out.push(build(`${repo}.branch[${asIdent(call.branch)}].files-bulk.W`));
      }
      return dedup(out);
    }

    // ── Writes — PRs / comments ────────────────────────────────────────────
    case 'github__create_pull_request':
      return [
        build(`${repo}.pull_request.W`),
        build(`${repo}.branch[${asIdent(call.head)}].propose-to[${asIdent(call.base)}].W`),
      ];
    case 'github__merge_pull_request':
      return [
        build(`${repo}.pull_request[${call.pullNumber}].W`),
        build(`${repo}.branch[${asIdent(call.base)}].merge-into.W`),
      ];
    case 'github__add_issue_comment':
      // Trailing `comment` name — no leaf id (unknown before posting).
      return [build(`${repo}.issue[${call.issueNumber}].comment.W`)];

    // ── Writes — releases ──────────────────────────────────────────────────
    case 'github__create_release':
      return [build(`${repo}.release.W`), build(`${repo}.tag[${asIdent(call.tagName)}].W`)];
    case 'github__delete_release':
      return [build(`${repo}.release[${call.releaseId}].W`)];

    // ── Writes — rules ─────────────────────────────────────────────────────
    case 'github__update_branch_protection':
      return [build(`${repo}.branch-protection[${asIdent(call.branch)}].W`)];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** One `file[<path>].W` slice per path, plus the `workflow-via-file` marker once a path is a workflow YAML. */
function fileWriteSlices(repo: string, branch: string, paths: readonly string[]): Slice[] {
  const out: Slice[] = [];
  for (const path of paths) {
    out.push(build(`${repo}.branch[${asIdent(branch)}].file[${asIdent(path)}].W`));
    if (isWorkflowPath(path)) {
      out.push(build(`${repo}.branch[${asIdent(branch)}].workflow-via-file.W`));
    }
  }
  return out;
}

/** GitHub recognizes workflow files at `.github/workflows/*.yml` and `.yaml`. */
export function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i.test(path);
}

/**
 * Render a checked identifier as a slice bracket-ident : characters outside
 * `[a-zA-Z0-9_./~-]` — the wildcard `*` included — are replaced by `-`, so
 * the slice parses and stays concrete. This only shapes the slice : the
 * request carries the identifier itself, and a string whose rendering is a
 * protected name (`main`) is that name, character for character.
 */
function asIdent(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_./~-]/g, '-');
  return cleaned.length > 0 ? cleaned : '_';
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
