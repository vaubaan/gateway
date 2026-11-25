/**
 * Identifier injection : every value of the arguments (or of the account)
 * that reaches a request path, a query string or a request body is fed the
 * same hostile values, to `classify` AND to `execute`.
 *
 * The rule under test : what is sent is exactly what was classified. A value
 * is either refused by both — and then nothing is sent, not even the token
 * — or accepted by both, and then every request names the repository
 * and the resource of the slice : the path GitHub receives is the path that
 * was built (no dot segment for a URL parser to remove) and it is one of the
 * paths the tool is expected to call.
 *
 * Octokit percent-encodes a path parameter with `encodeURIComponent`, which
 * leaves `.` and `..` as they are : `/contents/..` is sent as the repository
 * endpoint. The grammars of `classify.ts` are what makes that impossible.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, type MockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { classifyGithub } from '../../src/classify.ts';
import { githubPlugin } from '../../src/index.ts';
import { appRepo, accountCtx, executeCtx } from './fixtures.ts';

const API = 'https://api.github.com';
const R = '/repos/acme/app';
const base = { owner: 'acme', repo: 'app' };
const enc = encodeURIComponent;

const LONG = 'x'.repeat(5000);

/** The values every identifier position is fed. */
const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  '',
  LONG,
  'a\nb',
  'a?x=1#y',
];

type Kind =
  | 'member'
  | 'optMember'
  | 'path'
  | 'revision'
  | 'optRevision'
  | 'branch'
  | 'optBranch'
  | 'segment'
  | 'label'
  | 'number';

/** The hostile values that are legitimate at a position of each kind ; every other one must be refused. */
const ACCEPTED: Readonly<Record<Kind, readonly string[]>> = {
  // An owner, a repository : only the mission's own.
  member: [],
  optMember: [''],
  // A file path : several segments, any character GitHub stores, no dot segment.
  path: ['a/b', '%2e%2e', '%2f', '..%2f', 'a?x=1#y'],
  // A git name : `/` separates components, `%` is an ordinary character.
  revision: ['a/b', '%2e%2e', '%2f'],
  optRevision: ['a/b', '%2e%2e', '%2f', ''],
  branch: ['a/b', '%2e%2e', '%2f'],
  optBranch: ['a/b', '%2e%2e', '%2f', ''],
  // One path segment (a workflow file name) ; an empty value is "not given".
  segment: ['%2e%2e', '%2f', '..%2f', 'a?x=1#y', ''],
  // A label name : sent in the body, never in a path ; blank, overlong or multi-line refused.
  label: ['..', '.', 'a/../b', 'a/b', '%2e%2e', '%2f', '..%2f', 'a?x=1#y'],
  number: [],
};

interface Sent {
  readonly method: string;
  /** The path as it was written in the request URL. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly json: unknown;
}

interface Position {
  readonly name: string;
  readonly kind: Kind;
  readonly tool: string;
  readonly args: (value: unknown) => Record<string, unknown>;
  /** Every path the tool may call for an accepted value. */
  readonly paths: (value: string) => readonly string[];
  /** Further checks on what was sent for an accepted value. */
  readonly sent?: (value: string, requests: readonly Sent[]) => void;
  /** The call may still fail after its first requests (a check against GitHub's answer). */
  readonly mayFailLater?: true;
}

const lastJson = (requests: readonly Sent[]): Record<string, unknown> =>
  requests.at(-1)!.json as Record<string, unknown>;

const PUSH_PATHS = (branch: string): readonly string[] => [
  `${R}/git/ref/${enc(`heads/${branch}`)}`,
  `${R}/git/commits/abc`,
  `${R}/git/blobs`,
  `${R}/git/trees`,
  `${R}/git/commits`,
  `${R}/git/refs/${enc(`heads/${branch}`)}`,
];

const POSITIONS: readonly Position[] = [
  {
    name: 'owner',
    kind: 'member',
    tool: 'github__list_branches',
    args: (v) => ({ owner: v, repo: 'app' }),
    paths: () => [],
  },
  {
    name: 'repo',
    kind: 'member',
    tool: 'github__list_branches',
    args: (v) => ({ owner: 'acme', repo: v }),
    paths: () => [],
  },
  {
    name: 'get_file_contents.path',
    kind: 'path',
    tool: 'github__get_file_contents',
    args: (v) => ({ ...base, path: v }),
    paths: (v) => [`${R}/contents/${enc(v)}`],
  },
  {
    name: 'get_file_contents.ref',
    kind: 'optRevision',
    tool: 'github__get_file_contents',
    args: (v) => ({ ...base, path: 'a.ts', ref: v }),
    paths: () => [`${R}/contents/a.ts`],
    sent: (v, requests) => expect(requests[0]!.query).toEqual(v === '' ? {} : { ref: v }),
  },
  {
    name: 'list_commits.sha',
    kind: 'optRevision',
    tool: 'github__list_commits',
    args: (v) => ({ ...base, sha: v }),
    paths: () => [`${R}/commits`],
    sent: (v, requests) => expect(requests[0]!.query).toEqual(v === '' ? {} : { sha: v }),
  },
  {
    name: 'get_commit.sha',
    kind: 'revision',
    tool: 'github__get_commit',
    args: (v) => ({ ...base, sha: v }),
    paths: (v) => [`${R}/commits/${enc(v)}`],
  },
  {
    name: 'list_workflow_runs.workflow_id',
    kind: 'segment',
    tool: 'github__list_workflow_runs',
    args: (v) => ({ ...base, workflow_id: v }),
    paths: (v) => [v === '' ? `${R}/actions/runs` : `${R}/actions/workflows/${enc(v)}/runs`],
  },
  {
    name: 'list_workflow_runs.branch',
    kind: 'optBranch',
    tool: 'github__list_workflow_runs',
    args: (v) => ({ ...base, branch: v }),
    paths: () => [`${R}/actions/runs`],
    sent: (v, requests) => expect(requests[0]!.query).toEqual(v === '' ? {} : { branch: v }),
  },
  {
    name: 'get_branch_protection.branch',
    kind: 'branch',
    tool: 'github__get_branch_protection',
    args: (v) => ({ ...base, branch: v }),
    paths: (v) => [`${R}/branches/${enc(v)}/protection`],
  },
  {
    name: 'update_branch_protection.branch',
    kind: 'branch',
    tool: 'github__update_branch_protection',
    args: (v) => ({
      ...base,
      branch: v,
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
    }),
    paths: (v) => [`${R}/branches/${enc(v)}/protection`],
  },
  {
    name: 'create_branch.branch',
    kind: 'branch',
    tool: 'github__create_branch',
    args: (v) => ({ ...base, branch: v }),
    paths: () => [R, `${R}/git/ref/heads%2Fmain`, `${R}/git/refs`],
    sent: (v, requests) => expect(lastJson(requests).ref).toBe(`refs/heads/${v}`),
  },
  {
    name: 'create_branch.from_branch',
    kind: 'optBranch',
    tool: 'github__create_branch',
    args: (v) => ({ ...base, branch: 'feature/x', from_branch: v }),
    paths: (v) =>
      v === ''
        ? [R, `${R}/git/ref/heads%2Fmain`, `${R}/git/refs`]
        : [`${R}/git/ref/${enc(`heads/${v}`)}`, `${R}/git/refs`],
  },
  {
    name: 'create_or_update_file.path',
    kind: 'path',
    tool: 'github__create_or_update_file',
    args: (v) => ({ ...base, branch: 'feature/x', path: v, content: 'x', message: 'm' }),
    paths: (v) => [`${R}/contents/${enc(v)}`],
  },
  {
    name: 'create_or_update_file.branch',
    kind: 'branch',
    tool: 'github__create_or_update_file',
    args: (v) => ({ ...base, branch: v, path: 'a.ts', content: 'x', message: 'm' }),
    paths: () => [`${R}/contents/a.ts`],
    sent: (v, requests) => expect(lastJson(requests).branch).toBe(v),
  },
  {
    name: 'delete_file.path',
    kind: 'path',
    tool: 'github__delete_file',
    args: (v) => ({ ...base, branch: 'feature/x', path: v, message: 'm', sha: 'd' }),
    paths: (v) => [`${R}/contents/${enc(v)}`],
  },
  {
    name: 'delete_file.branch',
    kind: 'branch',
    tool: 'github__delete_file',
    args: (v) => ({ ...base, branch: v, path: 'a.ts', message: 'm', sha: 'd' }),
    paths: () => [`${R}/contents/a.ts`],
    sent: (v, requests) => expect(lastJson(requests).branch).toBe(v),
  },
  {
    name: 'push_files.branch',
    kind: 'branch',
    tool: 'github__push_files',
    args: (v) => ({ ...base, branch: v, message: 'm', files: [{ path: 'a.ts', content: '1' }] }),
    paths: (v) => PUSH_PATHS(v),
  },
  {
    name: 'push_files.files[].path',
    kind: 'path',
    tool: 'github__push_files',
    args: (v) => ({
      ...base,
      branch: 'feature/x',
      message: 'm',
      files: [{ path: v, content: '1' }],
    }),
    paths: () => PUSH_PATHS('feature/x'),
    sent: (v, requests) => {
      const tree = requests.find((r) => r.path === `${R}/git/trees`)!.json as {
        tree: readonly { path: string }[];
      };
      expect(tree.tree.map((t) => t.path)).toEqual([v]);
    },
  },
  {
    name: 'create_pull_request.head',
    kind: 'branch',
    tool: 'github__create_pull_request',
    args: (v) => ({ ...base, title: 't', head: v, base: 'main' }),
    paths: () => [`${R}/pulls`],
    sent: (v, requests) => expect(lastJson(requests).head).toBe(v),
  },
  {
    name: 'create_pull_request.base',
    kind: 'branch',
    tool: 'github__create_pull_request',
    args: (v) => ({ ...base, title: 't', head: 'feature/x', base: v }),
    paths: () => [`${R}/pulls`],
    sent: (v, requests) => expect(lastJson(requests).base).toBe(v),
  },
  {
    name: 'merge_pull_request.base',
    kind: 'optBranch',
    tool: 'github__merge_pull_request',
    args: (v) => ({ ...base, pull_number: 1, base: v }),
    paths: () => [`${R}/pulls/1`, `${R}/pulls/1/merge`],
    // The mocked pull request targets `main` : any other declared base is refused after the read.
    mayFailLater: true,
  },
  {
    name: 'create_release.tag_name',
    kind: 'branch',
    tool: 'github__create_release',
    args: (v) => ({ ...base, tag_name: v }),
    paths: () => [`${R}/releases`],
    sent: (v, requests) => expect(lastJson(requests).tag_name).toBe(v),
  },
  {
    name: 'create_release.target_commitish',
    kind: 'optRevision',
    tool: 'github__create_release',
    args: (v) => ({ ...base, tag_name: 'v1.0.0', target_commitish: v }),
    paths: () => [`${R}/releases`],
    sent: (v, requests) =>
      expect(lastJson(requests).target_commitish).toBe(v === '' ? undefined : v),
  },
  {
    name: 'add_labels.labels',
    kind: 'label',
    tool: 'github__add_labels',
    args: (v) => ({ ...base, issue_number: 1, labels: [v] }),
    paths: () => [`${R}/issues/1/labels`],
    sent: (v, requests) => expect(lastJson(requests).labels).toEqual([v]),
  },
  ...(
    [
      ['github__get_pull_request', 'pull_number', {}],
      ['github__merge_pull_request', 'pull_number', {}],
      ['github__get_issue', 'issue_number', {}],
      ['github__add_issue_comment', 'issue_number', { body: 'hi' }],
      ['github__add_labels', 'issue_number', { labels: ['e2e'] }],
      ['github__update_issue', 'issue_number', { title: 't' }],
      ['github__get_issue_comments', 'issue_number', {}],
      ['github__get_pull_request_reviews', 'pull_number', {}],
      ['github__get_pull_request_comments', 'pull_number', {}],
      ['github__get_pull_request_files', 'pull_number', {}],
      ['github__reply_to_pull_request_comment', 'pull_number', { comment_id: 2, body: 'b' }],
      ['github__reply_to_pull_request_comment', 'comment_id', { pull_number: 1, body: 'b' }],
      ['github__delete_release', 'release_id', {}],
    ] as const
  ).map(([tool, key, extra]): Position => ({
    name: `${tool.slice('github__'.length)}.${key}`,
    kind: 'number',
    tool,
    args: (v) => ({ ...base, ...extra, [key]: v }),
    paths: () => [],
  })),
];

/** One answer that satisfies every call sequence of the dispatcher. */
const ANY_ANSWER = {
  default_branch: 'main',
  object: { sha: 'abc' },
  base: { ref: 'main' },
  tree: { sha: 'tree' },
  sha: 'sha',
};

function openFetch(): MockFetch {
  return mockFetch([{ url: () => true, body: ANY_ANSWER }]);
}

/** The requests sent to the REST API. */
function sentTo(fetch: MockFetch): Sent[] {
  const out: Sent[] = [];
  for (const call of fetch.calls) {
    const written = /^https:\/\/api\.github\.com(\/[^?#]*)/.exec(call.url);
    if (!written) throw new Error(`request outside the GitHub API : ${call.url}`);
    const parsed = new URL(call.url);
    // What a URL parser makes of the path is what GitHub receives.
    expect(parsed.origin).toBe(API);
    expect(parsed.pathname).toBe(written[1]);
    expect(parsed.hash).toBe('');
    out.push({
      method: call.method,
      path: written[1]!,
      query: Object.fromEntries(parsed.searchParams),
      json: call.json,
    });
  }
  return out;
}

async function run(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ fetch: MockFetch; failed: boolean }> {
  const fetch = openFetch();
  try {
    // Declined by the executor (an `isError` result) or failed at the service (a throw).
    const result = await githubPlugin.execute(executeCtx(fetch), tool, args);
    return { fetch, failed: result.isError === true };
  } catch {
    return { fetch, failed: true };
  }
}

const label = (value: unknown): string =>
  typeof value === 'string' && value.length > 40
    ? `a ${value.length}-character value`
    : JSON.stringify(value);

const CASES = POSITIONS.flatMap((position) =>
  HOSTILE.map((value) => [position.name, label(value), position, value] as const),
);

describe('identifier positions — classify and execute agree on every hostile value', () => {
  test.each(CASES)('%s = %s', async (_name, _label, position, value) => {
    const args = position.args(value);
    const outcome = classifyGithub(position.tool, args, [appRepo]);
    const accepted = 'slices' in outcome;
    expect(accepted).toBe(ACCEPTED[position.kind].includes(value));

    const { fetch, failed } = await run(position.tool, args);
    if (!accepted) {
      // Refused by the executor too, before any call.
      expect(failed).toBe(true);
      expect(fetch.calls).toHaveLength(0);
      return;
    }
    if (position.mayFailLater !== true) expect(failed).toBe(false);
    const requests = sentTo(fetch);
    const allowed = position.paths(value);
    for (const request of requests) expect(allowed).toContain(request.path);
    if (!failed) position.sent?.(value, requests);
  });
});

describe('identifier positions — numbers', () => {
  test.each([1.5, -1, 0, 1e21, Number.NaN, Number.POSITIVE_INFINITY, '1', '1/../2', null])(
    'pull_number %j is refused by classify and by execute',
    async (value) => {
      const args = { ...base, pull_number: value };
      for (const tool of ['github__get_pull_request', 'github__merge_pull_request']) {
        expect(classifyGithub(tool, args, [appRepo])).toHaveProperty('denied');
        const { fetch, failed } = await run(tool, args);
        expect(failed).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    },
  );

  test('a positive integer names exactly that pull request, issue and release', async () => {
    const pull = await run('github__get_pull_request', { ...base, pull_number: 42 });
    expect(sentTo(pull.fetch).map((r) => r.path)).toEqual([`${R}/pulls/42`]);
    const issue = await run('github__get_issue', { ...base, issue_number: 7 });
    expect(sentTo(issue.fetch).map((r) => r.path)).toEqual([`${R}/issues/7`]);
    const release = await run('github__delete_release', { ...base, release_id: 9 });
    expect(sentTo(release.fetch).map((r) => r.path)).toEqual([`${R}/releases/9`]);
  });

  test.each([1.5, -1, 0, 1e21, Number.NaN, '1', '1/../2', '..', null])(
    'run_id and job_id %j are refused by classify and by execute',
    async (value) => {
      for (const [tool, key] of [
        ['github__list_workflow_jobs', 'run_id'],
        ['github__get_job_logs', 'job_id'],
      ] as const) {
        const args = { ...base, [key]: value };
        expect(classifyGithub(tool, args, [appRepo])).toHaveProperty('denied');
        const { fetch, failed } = await run(tool, args);
        expect(failed).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    },
  );

  test('a positive integer names exactly that run and that job', async () => {
    const jobs = await run('github__list_workflow_jobs', { ...base, run_id: 42 });
    expect(sentTo(jobs.fetch).map((r) => r.path)).toEqual([`${R}/actions/runs/42/jobs`]);
    const logs = await run('github__get_job_logs', { ...base, job_id: 7 });
    expect(sentTo(logs.fetch).map((r) => r.path)).toEqual([`${R}/actions/jobs/7/logs`]);
  });
});

describe('identifier positions — what a legitimate value still reaches', () => {
  test.each([
    ['a dotted repository', 'acme/my.repo'],
    ['the `.github` repository', 'acme/.github'],
    ['an enterprise-managed owner', 'acme_corp/app-2'],
  ])('%s is a repository like another', async (_label, ref) => {
    const resources = [{ service: 'github', ref, displayName: ref }];
    const slash = ref.indexOf('/');
    const args = { owner: ref.slice(0, slash), repo: ref.slice(slash + 1) };
    expect(classifyGithub('github__list_branches', args, resources)).toHaveProperty('slices');
    const fetch = openFetch();
    await githubPlugin.execute(executeCtx(fetch, resources), 'github__list_branches', args);
    expect(sentTo(fetch).map((r) => r.path)).toEqual([`/repos/${ref}/branches`]);
  });

  test.each([
    'main',
    'feature/x',
    'release-1.2',
    'fix/issue-12_b',
    'dependabot/npm_and_yarn/lodash-4.17.21',
    'user@topic',
    'été',
  ])('the branch %j is accepted and sent as it is', async (branch) => {
    const args = { ...base, branch };
    expect(classifyGithub('github__get_branch_protection', args, [appRepo])).toHaveProperty(
      'slices',
    );
    const { fetch } = await run('github__get_branch_protection', args);
    expect(sentTo(fetch).map((r) => r.path)).toEqual([`${R}/branches/${enc(branch)}/protection`]);
  });

  test.each([
    '.github/workflows/ci.yml',
    'src/a b.ts',
    'docs/100%.md',
    'a/..b/c...d',
    '.env',
    'src/[id]/page.tsx',
  ])('the path %j is accepted and sent as it is', async (path) => {
    const args = { ...base, path };
    expect(classifyGithub('github__get_file_contents', args, [appRepo])).toHaveProperty('slices');
    const { fetch } = await run('github__get_file_contents', args);
    expect(sentTo(fetch).map((r) => r.path)).toEqual([`${R}/contents/${enc(path)}`]);
  });

  test.each(['HEAD~2', 'main^', 'v1.2.3', 'refs/tags/v1.2.3', '9f30f15'])(
    'the revision %j is accepted and sent as it is',
    async (sha) => {
      const args = { ...base, sha };
      expect(classifyGithub('github__get_commit', args, [appRepo])).toHaveProperty('slices');
      const { fetch } = await run('github__get_commit', args);
      expect(sentTo(fetch).map((r) => r.path)).toEqual([`${R}/commits/${enc(sha)}`]);
    },
  );

  test.each(['ci.yml', 'build and test.yaml', 12345])(
    'the workflow %j is accepted and sent as it is',
    async (workflowId) => {
      const args = { ...base, workflow_id: workflowId };
      expect(classifyGithub('github__list_workflow_runs', args, [appRepo])).toHaveProperty(
        'slices',
      );
      const { fetch } = await run('github__list_workflow_runs', args);
      expect(sentTo(fetch).map((r) => r.path)).toEqual([
        `${R}/actions/workflows/${enc(String(workflowId))}/runs`,
      ]);
    },
  );

  test('a pull request from a fork names its head `owner:branch`', async () => {
    const args = { ...base, title: 't', head: 'contributor:feature/x', base: 'main' };
    expect(classifyGithub('github__create_pull_request', args, [appRepo])).toHaveProperty('slices');
    const { fetch, failed } = await run('github__create_pull_request', args);
    expect(failed).toBe(false);
    expect(lastJson(sentTo(fetch)).head).toBe('contributor:feature/x');
  });
});

describe('identifier positions — more refusals, by classify and by execute alike', () => {
  const refusedByBoth = async (tool: string, args: Record<string, unknown>): Promise<void> => {
    expect(classifyGithub(tool, args, [appRepo])).toHaveProperty('denied');
    const { fetch, failed } = await run(tool, args);
    expect(failed).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  };

  test.each([
    'main.lock',
    '.hidden',
    'a//b',
    '/main',
    'main/',
    'a b',
    'a\tb',
    'a\\b',
    'a..b',
    'a~1',
    'a^',
    'a:b',
    'a*',
    'a[0]',
    'a@{1}',
    '@',
    '-rf',
    'main.',
    'a\u200bb',
    'a\u0000b',
    'refs/heads/main',
    'heads/main',
  ])('the branch %j is refused', async (branch) => {
    await refusedByBoth('github__update_branch_protection', { ...base, branch });
    await refusedByBoth('github__create_branch', { ...base, branch });
    await refusedByBoth('github__create_branch', {
      ...base,
      branch: 'feature/x',
      from_branch: branch,
    });
  });

  test.each(['/a.ts', 'a//b', 'a/', './a', 'a/./b', 'a\\b', 'a\u0000b', 'a\rb', 'a\u2028b'])(
    'the path %j is refused',
    async (path) => {
      await refusedByBoth('github__get_file_contents', { ...base, path });
      await refusedByBoth('github__delete_file', {
        ...base,
        branch: 'feature/x',
        path,
        message: 'm',
        sha: 'd',
      });
    },
  );

  test.each([{ id: 1 }, true, ['ci.yml'], 1.5, -3, 0])(
    'the workflow id %j is refused',
    async (workflowId) => {
      await refusedByBoth('github__list_workflow_runs', { ...base, workflow_id: workflowId });
    },
  );

  test.each([5, { ref: 'main' }, ['main']])(
    'an optional name that is not a string (%j) is refused, not read as absent',
    async (value) => {
      await refusedByBoth('github__get_file_contents', { ...base, path: 'a.ts', ref: value });
      await refusedByBoth('github__list_commits', { ...base, sha: value });
      await refusedByBoth('github__merge_pull_request', { ...base, pull_number: 1, base: value });
    },
  );

  test.each(['acme/app/x', 'acme', 'other/app', 'acme/app ', 'ACME/app', 'acme/../acme/app'])(
    'mint_install_token refuses the repository %j',
    async (repoFullName) => {
      await refusedByBoth('github__mint_install_token', { purpose: 'clone', repoFullName });
    },
  );

  test('an owner and a repository that only join to a mission ref are refused', async () => {
    const odd = [{ service: 'github', ref: 'acme/team/app', displayName: 'odd' }];
    for (const args of [
      { owner: 'acme/team', repo: 'app' },
      { owner: 'acme', repo: 'team/app' },
    ]) {
      expect(classifyGithub('github__list_branches', args, odd)).toHaveProperty('denied');
      const fetch = openFetch();
      await refusalText(
        githubPlugin.execute(executeCtx(fetch, odd), 'github__list_branches', args),
      );
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a call without a repository never gets an installation-wide token', async () => {
    for (const args of [{}, { owner: 'acme' }, { owner: 'acme', repo: '' }, { repo: 'app' }]) {
      const { fetch, failed } = await run('github__list_branches', args);
      expect(failed).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a default branch GitHub answers that is not a branch name stops create_branch', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${API}${R}`, body: { default_branch: '../../tags/v1' } },
      { url: () => true, body: ANY_ANSWER },
    ]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__create_branch', {
        ...base,
        branch: 'feature/x',
      }),
    ).rejects.toThrow(/default branch/);
    expect(sentTo(fetch).map((r) => r.path)).toEqual([R]);
  });
});

describe('identifier positions — the account', () => {
  test('discovery lists only repositories a call can name', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (url) => url.startsWith(`${API}/user/repos?`),
        body: [
          { full_name: 'acme/app' },
          { full_name: 'acme/.github' },
          { full_name: 'acme/..' },
          { full_name: 'acme/a/b' },
          { full_name: 'acme' },
        ],
      },
    ]);
    const warnings: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => void warnings.push(message),
      error: () => undefined,
    };
    const resources = await githubPlugin.discoverResources(accountCtx(fetch, { logger }));
    expect(resources.map((r) => r.ref)).toEqual(['acme/app', 'acme/.github']);
    expect(warnings).toHaveLength(3);
  });
});
