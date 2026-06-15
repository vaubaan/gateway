/**
 * GitHub provider — declarative data-model (Phase 0).
 *
 * Spec  : docs/spec/gateway-risk-model.md §2.
 * Source : .vaubaan/research/providers/github.md §1.
 *
 * Single plane `repo`. The data-model declares every entity touched by
 * a tool's slice (the path leaves and intermediate containment nodes),
 * with its cardinalities and containment parent. The risk catalog's
 * `matches` patterns must reference only entities declared here ; this
 * makes catalog drift detectable at CI time.
 *
 * Verbs derived from containment that appear in slices but are NOT entities :
 *   - `branch[X].merge-into`        : produced by `merge_pull_request`
 *   - `branch[X].propose-to[Y]`     : produced by `create_pull_request`
 *   - `branch[X].workflow-via-file` : produced when a `file[]` write
 *     targets a path under `.github/workflows/*.yml` — the slice has a
 *     "virtual" leaf that the catalog can target without a top-level
 *     `workflow` entity write surface.
 *
 * Account-plane entities (`org`, organization-level collaborators, etc.) are
 * intentionally absent : the current MCP tool set does not touch them. Adding
 * a future `account` plane would be a parallel declaration here, not a
 * breaking change to the `repo` plane.
 */

import type { DataModel } from '@vaubaan/shared';

export const githubDataModel: DataModel = {
  provider: 'github',
  planes: [
    {
      slug: 'repo',
      description:
        'A single GitHub repository (`<owner>/<name>`), with its branches, ' +
        'files, PRs, issues, workflows, branch protection and credentials.',
      entities: [
        {
          name: 'repo',
          parent: null,
          cardinalities: ['one'],
          description:
            'The repository itself — root of the plane. One binding pins exactly one ' +
            '`<owner>/<repo>`. Not creatable via Vaubaan tools (out of scope).',
        },
        {
          name: 'branch',
          parent: 'repo',
          cardinalities: ['one', 'bounded', 'unbounded'],
          description:
            'A named ref (branch). Acts as the *env* for files and commits ' +
            '(spec §2.1) : `branch[main]` ≠ `branch[feature/x]`. Cardinality ' +
            'emerges from the selector — `[main]` is `one`, `[feature/*]` is ' +
            '`unbounded`.',
        },
        {
          name: 'file',
          parent: 'branch',
          cardinalities: ['one', 'unbounded'],
          description:
            'A file path, anchored to a specific branch (parent). Bulk writes ' +
            'emit `file[*]` (cardinality `unbounded`) ; single-file writes ' +
            'emit `file[<path>]` (cardinality `one`).',
        },
        {
          name: 'commit',
          parent: 'branch',
          cardinalities: ['one', 'unbounded'],
          description:
            'A commit on a branch. Read-only via tools — mutations are emitted ' +
            'implicitly when files are pushed.',
        },
        {
          name: 'tag',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A named tag on the repository. Created implicitly by `create_release` ' +
            'when the tag does not yet exist.',
        },
        {
          name: 'release',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A GitHub release record (notes, assets, draft/prerelease flags). ' +
            'References a tag.',
        },
        {
          name: 'pull_request',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A pull request from a head ref to a base ref. Merging produces a ' +
            'commit on the base branch — captured by a secondary slice ' +
            '`branch[<base>].merge-into.W`.',
        },
        {
          name: 'issue',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A GitHub issue. The issue/PR number space is unified by GitHub, so ' +
            'issue-level comments cover PR comments as well (slice ' +
            '`issue[N].comment[*].W`).',
        },
        {
          name: 'comment',
          parent: 'issue',
          cardinalities: ['one', 'unbounded'],
          description: 'A comment on an issue or PR (union space — see `issue`).',
        },
        {
          name: 'workflow',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A workflow definition (`.github/workflows/*.yml`). Read-only via ' +
            'tools — mutations only happen via `file[]` writes on the YAML ' +
            '(captured by the `branch[**].workflow-via-file.W` virtual slice).',
        },
        {
          name: 'workflow-run',
          parent: 'workflow',
          cardinalities: ['one', 'unbounded'],
          description:
            'A run instance of a workflow. Read-only via tools after spec v4 ' +
            '§7.2 #1 retired `dispatch_workflow`, `cancel_workflow_run`, ' +
            '`rerun_workflow_run`.',
        },
        {
          name: 'branch-protection',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'The protection rules attached to a branch (required reviews, ' +
            'status checks, restrictions). Writing here is a posture-shift — ' +
            "the rule survives the token's lifetime.",
        },
        {
          name: 'collaborator',
          parent: 'repo',
          cardinalities: ['one', 'unbounded'],
          description:
            'A user with explicit access to the repo. Present in the data-model ' +
            'for exhaustiveness ; no current MCP tool writes here.',
        },
        {
          name: 'secret',
          parent: 'repo',
          cardinalities: ['one', 'bounded'],
          description:
            'A repository Actions secret. Reserved for a future tool surface ; ' +
            'no current MCP tool touches secrets directly.',
        },
        {
          name: 'install-token',
          parent: 'repo',
          cardinalities: ['one'],
          description:
            'A short-lived GitHub App installation credential (1h TTL), minted ' +
            'with `purpose=clone` or `purpose=push`. Once minted, this token ' +
            "leaves Vaubaan's gating perimeter — capability sensitivity is " +
            'decided at mint time, by risk.',
        },
        {
          name: 'repo-settings',
          parent: 'repo',
          cardinalities: ['one'],
          description:
            'The singleton repo configuration (visibility, default branch, ' +
            'archive flag, etc.). Reserved — no current tool surface.',
        },
      ],
    },
  ],
};
