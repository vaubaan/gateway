/**
 * Data model of the `github` provider.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/github.md.
 *
 * Single plane `repo`. The data model declares every entity a slice path
 * can name (leaves and intermediate containment nodes), with cardinalities
 * and containment parent. One `Resource` of a connection is one repository
 * (`owner/name`) ; its `ref` is the first bracketed segment of every slice.
 *
 * Virtual leaves derived from containment — they appear in slices and
 * catalog patterns but are NOT entities :
 *   - `branch[X].merge-into`        : emitted by `merge_pull_request`
 *   - `branch[X].propose-to[Y]`     : emitted by `create_pull_request`
 *   - `branch[X].workflow-via-file` : emitted when a `file[]` write targets
 *     a path under `.github/workflows/*.yml`
 *   - `branch[X].files-bulk`        : emitted by `push_files` with 2+ files
 *
 * Account-plane entities (`org`, organization-level collaborators…) are
 * intentionally absent : the current tool set does not touch them. A future
 * `account` plane is a parallel declaration, not a change to `repo`.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

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
            'The repository itself — root of the plane and the resource a connection ' +
            'exposes (`<owner>/<repo>`). Not creatable via Vaubaan tools (out of scope).',
        },
        {
          name: 'branch',
          parent: 'repo',
          cardinalities: ['one', 'bounded', 'unbounded'],
          envScopable: true,
          description:
            'A named ref (branch). Acts as the *env* for files and commits ' +
            '(risk-model spec §2.3) : `branch[main]` ≠ `branch[feature/x]`. Cardinality ' +
            'emerges from the selector — `[main]` is `one`, `[feature/*]` is ' +
            '`unbounded`.',
        },
        {
          name: 'file',
          parent: 'branch',
          cardinalities: ['one', 'unbounded'],
          description:
            'A file path, anchored to a specific branch (parent). Bulk writes ' +
            'emit one `file[<path>]` slice per file plus the `files-bulk` virtual ' +
            'leaf ; single-file writes emit `file[<path>]` (cardinality `one`).',
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
          name: 'delete',
          parent: 'release',
          cardinalities: ['one'],
          description:
            'Synthetic verb leaf — deletion of a release. Distinct from publishing one : ' +
            'the notes and assets are lost, and consumers of their URLs get 404s.',
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
            '`issue[N].comment.W`).',
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
            'A run instance of a workflow. Read-only via tools since the ' +
            'risk-model spec §7.2 #1 retired `dispatch_workflow`, ' +
            '`cancel_workflow_run`, `rerun_workflow_run`.',
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
            'A user with explicit access to the repo. Present in the data model ' +
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
            "leaves Vaubaan's gating perimeter — sensitivity is decided at mint " +
            'time, by risk.',
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
