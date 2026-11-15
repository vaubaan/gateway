/**
 * The jobs of a workflow run and the log of one job : what is classified,
 * what is sent, and how the log is bounded. No test reaches GitHub.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { JOB_LOG_DEFAULT_BYTES, JOB_LOG_MAX_BYTES } from '../../src/call.ts';
import { classifyGithub } from '../../src/classify.ts';
import { githubPlugin } from '../../src/index.ts';
import { readLogWindow } from '../../src/job-logs.ts';
import { PAT, appRepo, executeCtx } from './fixtures.ts';

const repo = { owner: 'acme', repo: 'app' };
const API = 'https://api.github.com/repos/acme/app';
const DOWNLOAD = 'https://results-receiver.actions.githubusercontent.com/logs/9?sig=secret';

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

function slicesOf(tool: string, args: Record<string, unknown>): string[] {
  const outcome = classifyGithub(tool, args, [appRepo]);
  if (!('slices' in outcome)) throw new Error(`denied: ${outcome.denied}`);
  return outcome.slices.map(serializeSlice);
}

function logRoutes(log: string) {
  return [
    {
      method: 'GET',
      url: `${API}/actions/jobs/9/logs`,
      status: 302,
      headers: { location: DOWNLOAD },
      body: '',
    },
    { method: 'GET', url: DOWNLOAD, body: log },
  ];
}

describe('classify — jobs and logs are read-meta reads', () => {
  // Through the declared parents : the run's workflow, and the job's run, are not
  // in the arguments, so they are "any".
  test('list_workflow_jobs → workflow[*].workflow-run[run].job.R', () => {
    expect(slicesOf('github__list_workflow_jobs', { ...repo, run_id: 7 })).toEqual([
      'github.repo[acme/app].workflow[*].workflow-run[7].job.R',
    ]);
  });

  test('get_job_logs → workflow[*].workflow-run[*].job[id].log.R, whatever the bounds', () => {
    expect(
      slicesOf('github__get_job_logs', { ...repo, job_id: 9, max_bytes: 10, tail: true }),
    ).toEqual(['github.repo[acme/app].workflow[*].workflow-run[*].job[9].log.R']);
  });

  test.each([
    ['github__list_workflow_jobs', { ...repo }],
    ['github__list_workflow_jobs', { ...repo, run_id: '7' }],
    ['github__list_workflow_jobs', { ...repo, run_id: 7, filter: 'everything' }],
    ['github__get_job_logs', { ...repo }],
    ['github__get_job_logs', { ...repo, job_id: -1 }],
    ['github__get_job_logs', { ...repo, job_id: 9, max_bytes: 0 }],
    ['github__get_job_logs', { ...repo, job_id: 9, max_bytes: JOB_LOG_MAX_BYTES + 1 }],
    ['github__get_job_logs', { ...repo, job_id: 9, max_bytes: '100' }],
    ['github__get_job_logs', { ...repo, job_id: 9, tail: 'yes' }],
  ])('%s %j is refused by classify and by execute, nothing sent', async (tool, args) => {
    expect(classifyGithub(tool, args, [appRepo])).toHaveProperty('denied');
    const fetch = mockFetch([]);
    expect(await refusalText(githubPlugin.execute(executeCtx(fetch), tool, args))).toContain(tool);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('execute — list_workflow_jobs', () => {
  test('lists the jobs of the run, cut down to what diagnoses it', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${API}/actions/runs/7/jobs?filter=all`,
        body: {
          total_count: 1,
          jobs: [
            {
              id: 9,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-10-18T10:00:00Z',
              completed_at: '2026-10-18T10:05:00Z',
              html_url: 'https://github.com/acme/app/actions/runs/7/job/9',
              run_attempt: 1,
              runner_name: 'GitHub Actions 2',
              labels: ['ubuntu-latest'],
              steps: [
                { number: 1, name: 'checkout', status: 'completed', conclusion: 'success' },
                {
                  number: 2,
                  name: 'npm test',
                  status: 'completed',
                  conclusion: 'failure',
                  started_at: 'x',
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__list_workflow_jobs', {
      ...repo,
      run_id: 7,
      filter: 'all',
    });
    expect(JSON.parse(text(result))).toEqual({
      total_count: 1,
      jobs: [
        {
          id: 9,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-10-18T10:00:00Z',
          completed_at: '2026-10-18T10:05:00Z',
          html_url: 'https://github.com/acme/app/actions/runs/7/job/9',
          run_attempt: 1,
          steps: [
            { number: 1, name: 'checkout', status: 'completed', conclusion: 'success' },
            { number: 2, name: 'npm test', status: 'completed', conclusion: 'failure' },
          ],
        },
      ],
    });
  });
});

describe('execute — get_job_logs', () => {
  test('follows the redirect without the token and returns the log as plain text', async () => {
    const fetch = mockFetch(logRoutes('line 1\nline 2\n'));
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__get_job_logs', {
      ...repo,
      job_id: 9,
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('line 1\nline 2\n');
    const [asked, download] = fetch.calls;
    expect(asked!.headers.authorization).toBe(`Bearer ${PAT}`);
    expect(download!.url).toBe(DOWNLOAD);
    expect(download!.headers.authorization).toBeUndefined();
  });

  test('keeps the beginning by default and says the log was truncated', async () => {
    const fetch = mockFetch(logRoutes('abcdefghij'));
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__get_job_logs', {
      ...repo,
      job_id: 9,
      max_bytes: 4,
    });
    expect(text(result)).toMatch(/^\[log truncated: the first 4 bytes; the log is longer/);
    expect(text(result).split('\n')[1]).toBe('abcd');
  });

  test('with tail keeps the end, and says how long the log was', async () => {
    const fetch = mockFetch(logRoutes('abcdefghij'));
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__get_job_logs', {
      ...repo,
      job_id: 9,
      max_bytes: 4,
      tail: true,
    });
    expect(text(result)).toBe('[log truncated: the last 4 bytes of 10]\nghij');
  });

  test('the download URL is in neither the result nor a failure', async () => {
    const ok = await githubPlugin.execute(
      executeCtx(mockFetch(logRoutes('x'))),
      'github__get_job_logs',
      { ...repo, job_id: 9 },
    );
    expect(JSON.stringify(ok)).not.toContain('sig=secret');

    const gone = mockFetch([
      ...logRoutes('x').slice(0, 1),
      { method: 'GET', url: DOWNLOAD, status: 403, body: 'expired' },
    ]);
    const failure = await githubPlugin
      .execute(executeCtx(gone), 'github__get_job_logs', { ...repo, job_id: 9 })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('sig=secret');
  });

  test('a redirect to anything but an https URL is not followed', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${API}/actions/jobs/9/logs`,
        status: 302,
        headers: { location: 'http://169.254.169.254/latest' },
        body: '',
      },
    ]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__get_job_logs', { ...repo, job_id: 9 }),
    ).rejects.toThrow(/https download URL/);
    expect(fetch.calls).toHaveLength(1);
  });

  test('an expired log (410) is a service failure with its status', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${API}/actions/jobs/9/logs`, status: 410, body: { message: 'Gone' } },
    ]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__get_job_logs', { ...repo, job_id: 9 }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 410 });
  });
});

describe('readLogWindow — at most max bytes kept', () => {
  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
  const decoded = (b: Uint8Array) => new TextDecoder().decode(b);

  test('a log within the bound is whole', async () => {
    const log = await readLogWindow(stream('ab', 'cd'), 4, false);
    expect({ text: decoded(log.bytes), read: log.read, truncated: log.truncated }).toEqual({
      text: 'abcd',
      read: 4,
      truncated: false,
    });
  });

  test('head: the first bytes across chunks, the rest not read', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('0123456789'));
        if (pulled > 100) controller.close();
      },
    });
    const log = await readLogWindow(body, 15, false);
    expect(decoded(log.bytes)).toBe('012345678901234');
    expect(log.truncated).toBe(true);
    expect(pulled).toBeLessThan(5);
  });

  test('tail: the last bytes across chunks, the whole log counted', async () => {
    const log = await readLogWindow(stream('aaaa', 'bbbb', 'cccc', 'dd'), 5, true);
    expect(decoded(log.bytes)).toBe('cccdd');
    expect(log.read).toBe(14);
    expect(log.truncated).toBe(true);
  });

  test('the default bound is 64 KiB', () => {
    expect(JOB_LOG_DEFAULT_BYTES).toBe(65536);
  });
});
