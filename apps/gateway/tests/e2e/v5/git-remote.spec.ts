/**
 * The gateway as the agent's git remote, end to end (spec §4.1 bis, §4.4;
 * ADR gateway-as-git-remote): the built server, the real `git` client, a
 * GitHub stand-in serving a real bare repository (`E2E_GIT`), the approval
 * answered in a browser.
 *
 *   the creator reads the Git block of the mission page → the agent clones
 *   with the kit's configuration (the key only in VAUBAAN_MISSION_TOKEN) →
 *   branch, commit, push → a push to main is refused by its permission → a
 *   force-push asks first, with the URL → the creator approves in the browser,
 *   reading GitHub's comparison link → the same push again passes.
 *
 * The session is written to `test-results/v5/git-session.txt`: what an agent
 * sees, command by command.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_APPROVER_USER, E2E_GIT, localOrigin, PUBLIC_URL } from './instance';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT = resolve(HERE, '../../../../../test-results/v5/git-session.txt');
const MISSION = 'Develop acme-git/app with git';
const REMOTE = `${PUBLIC_URL}/git/${E2E_GIT.repository}.git`;
/** The kit's credential helper, verbatim: the key is read from the variable. */
const KIT_HELPER = '!f() { echo username=mission; echo "password=$VAUBAAN_MISSION_TOKEN"; }; f';

interface Run {
  readonly code: number;
  readonly out: string;
}

const transcript: string[] = [];
const scratch: string[] = [];

function agentGit(home: string, token: string) {
  // The kit's two settings, plus what stands in for DNS here: the public URL is
  // reached on the local port. Nothing else is configured, nothing written.
  const config: Record<string, string> = {
    [`credential.${localOrigin()}.helper`]: KIT_HELPER,
    [`url.${localOrigin()}/.insteadOf`]: `${PUBLIC_URL}/`,
    'user.name': 'Agent',
    'user.email': 'agent@example.com',
    'init.defaultBranch': 'main',
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_ENV: 'test',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    VAUBAAN_MISSION_TOKEN: token,
    GIT_CONFIG_COUNT: String(Object.keys(config).length),
  };
  Object.entries(config).forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return (cwd: string, args: readonly string[]): Promise<Run> =>
    new Promise((done) => {
      execFile('git', [...args], { cwd, env, timeout: 60_000 }, (error, stdout, stderr) => {
        const out = `${String(stdout)}${String(stderr)}`.trimEnd();
        transcript.push(`$ git ${args.join(' ')}`, ...(out ? [out] : []), '');
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out });
      });
    });
}

async function upstreamRefs(request: APIRequestContext): Promise<Record<string, string>> {
  const response = await request.get(controlUrl('/git-refs'));
  return (await response.json()) as Record<string, string>;
}

test.afterAll(() => {
  mkdirSync(dirname(TRANSCRIPT), { recursive: true });
  writeFileSync(TRANSCRIPT, `${transcript.join('\n')}\n`);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test('an agent with a mission key and nothing else clones, pushes, is refused, asks, replays', async ({
  browser,
  request,
}) => {
  const response = await request.post(controlUrl('/git-mission'), { data: { name: MISSION } });
  expect(response.ok()).toBe(true);
  const issued = (await response.json()) as { mission_id: string; token: string };

  // ── The creator reads what git may do under this mission ─────────────────
  await signInAs(request, E2E_APPROVER_USER);
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  await page.goto(`/auth/login?return_to=/missions/${issued.mission_id}`);
  const block = page.getByTestId('mission-git');
  await expect(block).toContainText(REMOTE);
  await expect(page.getByTestId('git-can')).toContainText('clone and fetch');
  await expect(page.getByTestId('git-asks')).toContainText('force-push');
  await expect(page.getByTestId('git-cannot')).toContainText('push to main');

  // ── The agent: git, and the key in one variable ──────────────────────────
  const home = mkdtempSync(join(tmpdir(), 'vaubaan-e2e-agent-'));
  const work = mkdtempSync(join(tmpdir(), 'vaubaan-e2e-work-'));
  scratch.push(home, work);
  const git = agentGit(home, issued.token);
  transcript.push(
    `# Mission "${MISSION}" (developer preset). VAUBAAN_MISSION_TOKEN is set; git has the kit's credential helper.`,
    '',
  );

  expect((await git(work, ['clone', REMOTE, 'app'])).code).toBe(0);
  const repo = join(work, 'app');
  expect((await git(repo, ['switch', '-c', 'feature/hello'])).code).toBe(0);
  writeFileSync(join(repo, 'hello.txt'), 'hello\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'Say hello']);
  const pushed = await git(repo, ['push', '-u', 'origin', 'feature/hello']);
  expect(pushed.code).toBe(0);
  expect(pushed.out).toContain('[new branch]');

  // A push to main: the mission does not hold the permission.
  await git(repo, ['switch', 'main']);
  writeFileSync(join(repo, 'direct.txt'), 'straight to main\n');
  await git(repo, ['add', 'direct.txt']);
  await git(repo, ['commit', '-m', 'Straight to main']);
  const toMain = await git(repo, ['push', 'origin', 'main']);
  expect(toMain.code).not.toBe(0);
  expect(toMain.out).toContain(
    '[remote rejected] main -> main (permission github.merge-protected is not in this mission)',
  );

  // A rewrite of the feature branch: the developer preset asks first.
  await git(repo, ['switch', 'feature/hello']);
  await git(repo, ['commit', '--amend', '-m', 'Say hello, better']);
  const rewritten = (await git(repo, ['rev-parse', 'HEAD'])).out.trim();
  const asked = await git(repo, ['push', '--force', 'origin', 'feature/hello']);
  expect(asked.code).not.toBe(0);
  const approvalUrl = new RegExp(`approval required — (${PUBLIC_URL}/r/[0-9a-f-]{36})`).exec(
    asked.out,
  )?.[1];
  expect(approvalUrl, asked.out).toBeTruthy();
  expect(asked.out).toContain('Hand this URL to your human');
  expect((await upstreamRefs(request))['refs/heads/feature/hello']).not.toBe(rewritten);

  // ── The creator answers in the browser ───────────────────────────────────
  transcript.push(`# The human opens ${approvalUrl} and approves.`, '');
  await page.goto(approvalUrl!);
  await expect(page.getByTestId('approval-tool')).toContainText('github__git_push');
  await expect(page.getByTestId('approval-arguments')).toContainText('feature/hello');
  await expect(page.getByTestId('approval-provider-pages')).toContainText(
    'refs/heads/feature/hello',
  );
  await page.getByRole('button', { name: 'Approve this call' }).click();
  await expect(page.getByTestId('request-state')).toHaveText('approved');
  await context.close();

  // ── The same push again ──────────────────────────────────────────────────
  const replay = await git(repo, ['push', '--force', 'origin', 'feature/hello']);
  expect(replay.code).toBe(0);
  const refs = await upstreamRefs(request);
  expect(refs['refs/heads/feature/hello']).toBe(rewritten);
  expect(Object.keys(refs).filter((ref) => ref.startsWith('refs/vaubaan/'))).toEqual([]);
  // The key never landed in the repository's configuration.
  expect((await git(repo, ['config', '--list', '--local'])).out).not.toContain(issued.token);
});
