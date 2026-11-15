/**
 * Data model of the `github` service.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/github.md.
 *
 * One plane, `repo`, with two roots. `repo` : one `Resource` of an
 * account is one repository (`owner/name`) ; its `ref` is the first
 * bracketed segment of every slice under it. `search` : GitHub's global
 * search, which reaches every repository the token reaches, beyond those of
 * a mission — not a resource, never selected, decided by its own risk
 * (`github.search-global`). Kept in the one plane: a plane is what the
 * interface filters risks by, and the search is no area of its own.
 *
 * Every entity a slice path names is declared here, with its cardinalities
 * (how a slice names it : `[x]` or nothing `one`, `[a,b]` `bounded`, `[*]`
 * `unbounded`) and its containment parent. A slice walks the containment :
 * a job is named through its run and the run's workflow
 * (`workflow[*].workflow-run[<run>].job`), "any" where the arguments do not
 * name the parent.
 *
 * Virtual leaves — acts rather than entities, last in a slice, never
 * declared :
 *   - `branch[X].merge-into`        : emitted by `merge_pull_request`
 *   - `branch[X].propose-to[Y]`     : emitted by `create_pull_request`
 *   - `branch[X].workflow-via-file` : emitted when a `file[]` write targets
 *     a path under `.github/workflows/*.yml`
 *   - `branch[X].files-bulk`        : emitted by `push_files` with 2+ files
 *   - `<ref>.push`, `<ref>.force`, `<ref>.delete` : emitted by the git remote
 *
 * Account-plane entities (`org`, organization-level collaborators…) are
 * intentionally absent : the current tool set does not touch them. A future
 * `account` plane is a parallel declaration, not a change to `repo`.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const githubDataModel: DataModel = {
  service: SERVICE_ID,
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
            'The repository itself — root of the plane and the resource an account ' +
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
          name: 'label',
          parent: 'issue',
          // `[*]` : a name the slice grammar cannot carry.
          cardinalities: ['one', 'unbounded'],
          description:
            'A label put on an issue or PR (`add_labels`, slice `issue[N].label[<name>].W`, ' +
            'one per label). GitHub creates a label the repository does not have.',
        },
        {
          name: 'workflow',
          parent: 'repo',
          // `[*]` : the workflow of a run or a job, which their tools do not name.
          cardinalities: ['one', 'bounded', 'unbounded'],
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
          name: 'job',
          parent: 'workflow-run',
          cardinalities: ['one', 'unbounded'],
          description:
            'A job of a workflow run, with its steps and their conclusions. Read-only ' +
            'via tools (`list_workflow_jobs`, slice `workflow[*].workflow-run[<run>].job.R`).',
        },
        {
          name: 'log',
          parent: 'job',
          cardinalities: ['one'],
          description:
            'The log of a job (`get_job_logs`, slice ' +
            '`workflow[*].workflow-run[*].job[<id>].log.R`). Read-only ; ' +
            'what a step printed, secrets masked by GitHub.',
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
          name: 'repo-settings',
          parent: 'repo',
          cardinalities: ['one'],
          description:
            'The singleton repo configuration (visibility, default branch, ' +
            'archive flag, etc.). Reserved — no current tool surface.',
        },
        {
          name: 'search',
          parent: null,
          cardinalities: ['one'],
          description:
            "GitHub's global search (`search_code`, `search_issues`) : every repository the " +
            'token reaches, beyond the repositories of a mission. A second root of the plane, ' +
            'not a resource : nothing is selected, the search is decided by its own risk.',
        },
        {
          name: 'code',
          parent: 'search',
          cardinalities: ['one'],
          description: 'Code search (`search_code`, slice `search.code.R`).',
        },
        {
          name: 'issues',
          parent: 'search',
          cardinalities: ['one'],
          description:
            'Issue and pull-request search (`search_issues`, slice `search.issues.R`). ' +
            'The search, not an `issue` of a repository.',
        },
      ],
    },
  ],
};
