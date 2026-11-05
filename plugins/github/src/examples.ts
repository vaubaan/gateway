/**
 * Representative calls of every tool of the `github` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Branches are feature/* and protected names, so both write classes are
 * exercised and no sample lands on the fallback.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

/** The one repository the samples run on. */
export const EXAMPLE_REPOSITORY: Resource = {
  provider: PROVIDER_ID,
  ref: 'acme/app',
  displayName: 'acme/app',
};

const repo = { owner: 'acme', repo: 'app' };
const feature = 'feature/test';

/** One ref update of a push, as the host's review hands it to the git remote. */
function gitUpdate(
  ref: string,
  kind: 'create' | 'force' | 'delete',
  files: readonly string[] = ['a.ts'],
) {
  return {
    ref,
    old: kind === 'create' ? null : 'a'.repeat(40),
    new: kind === 'delete' ? null : 'b'.repeat(40),
    kind,
    commits: kind === 'delete' ? 0 : 1,
    files: kind === 'delete' ? [] : [...files],
    workflow_files: files.filter((f) => f.startsWith('.github/workflows/')),
  };
}

export const githubExamples: ToolSamples = samplesOn([EXAMPLE_REPOSITORY], {
  [TOOL.listBranches]: [{ args: { ...repo } }],
  [TOOL.listCommits]: [{ args: { ...repo } }, { args: { ...repo, sha: feature } }],
  [TOOL.listPullRequests]: [{ args: { ...repo, state: 'open' } }],
  [TOOL.listIssues]: [{ args: { ...repo } }],
  [TOOL.getFileContents]: [
    { args: { ...repo, path: 'README.md' } },
    { args: { ...repo, path: 'src/a.ts', ref: 'main' } },
  ],
  [TOOL.getPullRequest]: [{ args: { ...repo, pull_number: 1 } }],
  [TOOL.getIssue]: [{ args: { ...repo, issue_number: 1 } }],
  [TOOL.getCommit]: [{ args: { ...repo, sha: 'deadbeef' } }],
  [TOOL.searchCode]: [{ args: { q: 'foo' } }],
  [TOOL.searchIssues]: [{ args: { q: 'foo' } }],
  [TOOL.createBranch]: [
    { args: { ...repo, branch: feature } },
    { args: { ...repo, branch: 'release-2026' } },
  ],
  [TOOL.createOrUpdateFile]: [
    { args: { ...repo, branch: feature, path: 'src/a.ts', content: 'x', message: 'm' } },
    { args: { ...repo, branch: 'main', path: 'README.md', content: 'x', message: 'm' } },
    {
      args: {
        ...repo,
        branch: feature,
        path: '.github/workflows/ci.yml',
        content: 'x',
        message: 'm',
      },
    },
  ],
  [TOOL.pushFiles]: [
    {
      args: {
        ...repo,
        branch: feature,
        message: 'm',
        files: [
          { path: 'a.ts', content: '1' },
          { path: 'b.ts', content: '2' },
        ],
      },
    },
  ],
  [TOOL.createPullRequest]: [{ args: { ...repo, title: 't', head: feature, base: 'main' } }],
  [TOOL.addIssueComment]: [{ args: { ...repo, issue_number: 1, body: 'b' } }],
  [TOOL.addLabels]: [
    { args: { ...repo, issue_number: 1, labels: ['e2e'] } },
    { args: { ...repo, issue_number: 1, labels: ['bug', 'needs review'] } },
  ],
  [TOOL.listWorkflows]: [{ args: { ...repo } }],
  [TOOL.listWorkflowRuns]: [{ args: { ...repo } }, { args: { ...repo, workflow_id: 'ci.yml' } }],
  [TOOL.listWorkflowJobs]: [
    { args: { ...repo, run_id: 7 } },
    { args: { ...repo, run_id: 7, filter: 'all' } },
  ],
  [TOOL.getJobLogs]: [
    { args: { ...repo, job_id: 9 } },
    { args: { ...repo, job_id: 9, max_bytes: 1024, tail: true } },
  ],
  [TOOL.getBranchProtection]: [{ args: { ...repo, branch: 'main' } }],
  [TOOL.mergePullRequest]: [
    { args: { ...repo, pull_number: 1 } },
    { args: { ...repo, pull_number: 1, base: 'release-2026' } },
  ],
  [TOOL.deleteFile]: [{ args: { ...repo, branch: feature, path: 'a.ts', message: 'm', sha: 'd' } }],
  [TOOL.updateBranchProtection]: [{ args: { ...repo, branch: 'main' } }],
  [TOOL.listReleases]: [{ args: { ...repo } }],
  [TOOL.listTags]: [{ args: { ...repo } }],
  [TOOL.createRelease]: [{ args: { ...repo, tag_name: 'v1.0.0' } }],
  [TOOL.deleteRelease]: [{ args: { ...repo, release_id: 1 } }],
  // The git remote's two tools : their arguments are the host's review.
  [TOOL.gitFetch]: [{ args: { repository: 'acme/app', step: 'pack' } }],
  [TOOL.gitPush]: [
    {
      args: {
        repository: 'acme/app',
        updates: [
          gitUpdate('refs/heads/feature/test', 'create'),
          gitUpdate('refs/heads/main', 'force', ['.github/workflows/ci.yml']),
          gitUpdate('refs/heads/feature/old', 'delete'),
          gitUpdate('refs/tags/v1.0.0', 'create'),
        ],
      },
    },
    {
      args: { repository: 'acme/app', updates: [gitUpdate('refs/notes/x', 'create')] },
      expectDenied: true,
    },
  ],
});
