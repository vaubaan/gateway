/**
 * GitHub classifier (v4 risk-based) — maps a concrete (tool, args) call to
 * the `Slice[]` it touches, in GitHub-native semantics.
 *
 * Spec   : docs/spec/gateway-risk-model.md §§3, 7.
 * Source : .vaubaan/research/providers/github.md §2 (tool → slice mapping).
 *
 * Coexistence note : `classify.ts` (v1, capability-based) lives next to this
 * module untouched until Phase 3 of the v4 migration. New code consumes
 * `classifyGithubV4` ; legacy MCP routes still call `classifyGithub` (v1).
 *
 * Compared to v1, the classifier :
 *  - returns one OR MORE `Slice` per call (multi-slice tools : `merge_pull_request`,
 *    `create_pull_request`, `create_release`, `create_or_update_file` over a
 *    workflow YAML, `push_files`).
 *  - does NOT carry a binding back to the caller — the binding is implicit
 *    in the slice's `repo[owner/name]` segment.
 *  - strictly refuses tools retired by spec v4 §7.2 #1 :
 *    `github__dispatch_workflow`, `github__cancel_workflow_run`,
 *    `github__rerun_workflow_run` — they return `{ denied: ... }` with the
 *    migration message.
 *
 * Virtual slice leaves (verbs derived from the data-model — see
 * `data-model.ts`) used here :
 *  - `branch[X].merge-into.W`        — secondary slice of `merge_pull_request`
 *  - `branch[X].propose-to[Y].W`     — secondary slice of `create_pull_request`
 *  - `branch[X].workflow-via-file.W` — secondary slice when a file write
 *    targets `.github/workflows/*.yml`
 *  - `branch[X].files-bulk.W`        — secondary slice of `push_files`,
 *    distinguishing a multi-file commit from a single-file write
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';
import { parseSlice } from '@vaubaan/policy-engine';

/** Return shape of the v4 classifier. */
export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

const PROVIDER = 'github';

/** Tools retired by spec v4 §7.2 #1. Returning a denial here (instead of
 *  letting them slip through) makes the migration safety explicit even when
 *  the tool descriptor list still advertises them. */
const RETIRED_TOOLS = new Set<string>([
  'github__dispatch_workflow',
  'github__cancel_workflow_run',
  'github__rerun_workflow_run',
]);

const RETIRED_HINT = 'tool removed in v4 risk-based model — use cloud-provider tool directly';

const MINT_TOOL = 'github__mint_install_token';

const GLOBAL_SEARCH = new Set<string>(['github__search_code', 'github__search_issues']);

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export function classifyGithubV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: readonly ProviderBinding[],
): ClassifyV4Result {
  // Retired tools — phase v4 §7.2 #1.
  if (RETIRED_TOOLS.has(tool)) {
    return { denied: RETIRED_HINT };
  }

  // Global searches — not repo-scoped, so no binding lookup.
  if (GLOBAL_SEARCH.has(tool)) {
    const kind = tool === 'github__search_code' ? 'code' : 'issues';
    return { slices: [build(`${PROVIDER}.search.${kind}.R`)] };
  }

  const boundRepos = githubRepoRefs(bindings);

  // Credential mint — special handling: the slice depends on `purpose`,
  // and the optional `repoFullName` arg narrows the binding fan-out.
  if (tool === MINT_TOOL) {
    return classifyMintInstallToken(args, boundRepos);
  }

  // Every other tool needs `owner` + `repo` and must resolve to a binding.
  const repoRef = resolveRepoRef(args, boundRepos);
  if (typeof repoRef === 'object') return repoRef; // {denied:...}

  switch (tool) {
    // ── Reads — code / branch / commit / file / tag ────────────────────────
    //
    // "List all <entity>" reads emit the entity name WITHOUT a leaf segment
    // (e.g. `repo[X].branch.R`, not `repo[X].branch[*].R`). Concrete slices
    // never contain wildcards — `[*]` / `[**]` belong to *patterns* only.
    // The matcher's terminal `wild-rec` in catalog patterns (`branch[**].R`)
    // absorbs the zero-or-more trailing segments, so the read is correctly
    // categorized without forcing a runtime wildcard in the concrete slice.
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
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].${tail}`)],
      };
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
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].W`)],
      };
    }
    case 'github__create_or_update_file': {
      const branch = strArg(args, 'branch');
      const path = strArg(args, 'path');
      if (!branch || !path) {
        return denied(tool, "requires 'branch' and 'path'");
      }
      const out: Slice[] = [
        build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].file[${asIdent(path)}].W`),
      ];
      if (isWorkflowPath(path)) {
        out.push(
          build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].workflow-via-file.W`),
        );
      }
      return { slices: out };
    }
    case 'github__push_files': {
      const branch = strArg(args, 'branch');
      if (!branch) return denied(tool, "requires 'branch'");
      const files = readFileEntries(args);
      if (!files.length) return denied(tool, "requires non-empty 'files' array");
      const out: Slice[] = [];
      // One slice per file (concrete) + the `files-bulk` marker to distinguish
      // a multi-file commit from a single-file write at the catalog level.
      for (const f of files) {
        out.push(
          build(
            `${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].file[${asIdent(f.path)}].W`,
          ),
        );
        if (isWorkflowPath(f.path)) {
          out.push(
            build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].workflow-via-file.W`),
          );
        }
      }
      if (files.length > 1) {
        out.push(build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].files-bulk.W`));
      }
      return { slices: dedup(out) };
    }
    case 'github__delete_file': {
      const branch = strArg(args, 'branch');
      const path = strArg(args, 'path');
      if (!branch || !path) {
        return denied(tool, "requires 'branch' and 'path'");
      }
      const out: Slice[] = [
        build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].file[${asIdent(path)}].W`),
      ];
      if (isWorkflowPath(path)) {
        out.push(
          build(`${PROVIDER}.repo[${repoRef}].branch[${asIdent(branch)}].workflow-via-file.W`),
        );
      }
      return { slices: out };
    }

    // ── Writes — PRs / comments ────────────────────────────────────────────
    case 'github__create_pull_request': {
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (!head || !base) {
        return denied(tool, "requires 'head' and 'base'");
      }
      return {
        slices: [
          // No leaf segment after `pull_request` — see Reads note above.
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
      // Trailing `comment` name — no leaf id (we don't know it before posting).
      return {
        slices: [build(`${PROVIDER}.repo[${repoRef}].issue[${n}].comment.W`)],
      };
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

function classifyMintInstallToken(
  args: Record<string, unknown>,
  boundRepos: readonly string[],
): ClassifyV4Result {
  const purpose = args.purpose;
  if (purpose !== 'clone' && purpose !== 'push') {
    return { denied: `${MINT_TOOL} requires purpose 'clone' or 'push'` };
  }
  const repoArg = strArg(args, 'repoFullName');
  if (repoArg) {
    if (!boundRepos.includes(repoArg)) {
      return { denied: `repo '${repoArg}' is not bound to this project` };
    }
    return {
      slices: [build(`${PROVIDER}.repo[${repoArg}].install-token[${purpose}].W`)],
    };
  }
  // No repoFullName → fan out to every bound repo (matches the implementation
  // in `github-adapter.ts` mintUpstreamToken).
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
// Argument and binding helpers
// ─────────────────────────────────────────────────────────────────────────────

function githubRepoRefs(bindings: readonly ProviderBinding[]): string[] {
  const out: string[] = [];
  for (const b of bindings) {
    if (b.provider === 'github') out.push(b.resource_ref);
  }
  return out;
}

/** Resolve `<owner>/<repo>` from args and check it is in `boundRepos`.
 *  Returns the ref string on success, or a denial result on failure. */
function resolveRepoRef(
  args: Record<string, unknown>,
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

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numArgAsStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
}

interface FileEntry {
  path: string;
  content: string;
}

function readFileEntries(args: Record<string, unknown>): FileEntry[] {
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

function isWorkflowPath(path: string): boolean {
  // GitHub recognizes workflow files at `.github/workflows/*.yml` and `.yaml`.
  return /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i.test(path);
}

/** Render an arbitrary string as a slice bracket-ident. The DSL accepts
 *  `[a-zA-Z0-9_./~/*-]+` inside brackets ; characters outside that set are
 *  replaced by `-` so the resulting slice still parses. Catalogues should
 *  match on patterns broad enough that the exact sanitized value rarely
 *  matters. */
function asIdent(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_./*~-]/g, '-');
  return cleaned.length > 0 ? cleaned : '_';
}

function denied(tool: string, message: string): { denied: string } {
  return { denied: `tool '${tool}' ${message}` };
}

function build(input: string): Slice {
  // Parse at runtime — the DSL parser validates the shape, catching typos
  // close to the call site rather than at the matcher's silent rejection.
  return parseSlice(input);
}

function dedup(slices: readonly Slice[]): Slice[] {
  const seen = new Set<string>();
  const out: Slice[] = [];
  for (const s of slices) {
    const key = serializeForDedup(s);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function serializeForDedup(s: Slice): string {
  // Tiny in-module serializer — independent of `serializeSlice` to keep this
  // module self-contained (the policy-engine import already exposes parseSlice
  // but not the serializer, and we only need this for dedup-by-string).
  return JSON.stringify({ p: s.provider, a: s.action, path: s.path });
}
