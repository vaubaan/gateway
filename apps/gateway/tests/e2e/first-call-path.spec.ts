/**
 * From a first account to the agent's first governed call, counted (intent "Count six
 * actions from the download to the first call"; plate 7 of the 2026-11-19 research).
 *
 * The six actions of a person: install the app, first access (the key, then an email
 * and a password), connect an account, create the mission, add it to my agent, first
 * call. The first two happen before the browser reaches this page (handbook
 * desktop-app, "Test the first-call path"); this spec walks the four others on an
 * instance, with a service that takes a pasted key, and fails if the path grows:
 *
 * - each action is counted where the person does it, and the total with the two
 *   outside must stay at six;
 * - the screens crossed are exactly the ones of the path: nothing sends the person
 *   back to the home, to the account's page or to a blank mission form;
 * - no screen asks for a step one person does not need (giving access, labelling an
 *   environment no permission uses).
 *
 * "Add it to my agent" is the line the page gives for Claude Code: the spec reads the
 * server's address and the header from that line alone and connects an MCP client with
 * them, as running the line does.
 */
import { expect, test, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { routeToInstance, signInAs } from './browser';
import { E2E_FIRST_CALL_USER, MOCK_GITHUB, PUBLIC_URL } from './instance';

/** What a person does before the browser shows the home: install, then first access. */
const ACTIONS_BEFORE_THE_HOME = ['install the app', 'first access'] as const;
const MOST_ACTIONS = 6;
const [REPOSITORY] = MOCK_GITHUB.repositories;
const [OWNER, REPO] = REPOSITORY.split('/');
const ACCOUNT = 'First call org';

let agent: Agent | null = null;

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_FIRST_CALL_USER);
});
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

/** The screens a page crosses, as paths, one entry per change. */
function screensOf(page: Page): string[] {
  const screens: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const { pathname } = new URL(frame.url());
    // Not screens: the sign-in's hops (the test's identity provider included) and the
    // address a form posts to, which answers with a redirect.
    if (pathname.startsWith('/auth/') || pathname === '/login' || pathname === '/authorize') return;
    if (pathname.startsWith('/accounts/connect/')) return;
    const screen = pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>');
    if (screens.at(-1) !== screen) screens.push(screen);
  });
  return screens;
}

test('from a first account to the first governed call in four actions, six with the install and the setup', async ({
  page,
}) => {
  const actions: string[] = [...ACTIONS_BEFORE_THE_HOME];
  const screens = screensOf(page);

  // Where the setup leaves a person: the home of someone with nothing yet.
  await page.goto('/auth/login?return_to=/');
  await expect(page.getByTestId('now-steps')).toBeVisible();

  // ── 3. Connect an account ────────────────────────────────────────────────
  actions.push('connect an account');
  await page.getByTestId('now-steps').getByRole('link', { name: 'Connect an account' }).click();
  await page.getByTestId('service-github').getByRole('link').click();
  await page.getByLabel(/^Name/).fill(ACCOUNT);
  await page.getByLabel(/Fine-grained personal access token/).fill(MOCK_GITHUB.token);
  await page.getByLabel(/^Repository/).fill(REPOSITORY);
  await page.getByRole('button', { name: 'Check and connect' }).click();

  // The connection leads to the mission, filled in: no way back to find.
  await expect(page.getByTestId('starter-mission')).toContainText(ACCOUNT);
  // Nothing one person does not need: no environment to label, no access to give.
  await expect(page.getByTestId('starter-mission')).not.toContainText(/label|environment/i);
  await expect(page.getByText(/give access/i)).toHaveCount(0);

  // ── 4. Create the mission ────────────────────────────────────────────────
  actions.push('create the mission');
  await page.getByRole('button', { name: 'Create mission' }).click();
  const kit = page.getByTestId('created');
  await expect(kit.getByTestId('first-call-waiting')).toBeVisible();

  // ── 5. Add it to my agent ────────────────────────────────────────────────
  actions.push('add it to my agent');
  const line = (await kit.getByTestId('kit-claude-code').innerText()).replace(/\s+/g, ' ');
  // The line alone carries what the agent needs: the address and the key.
  const [, address] = /claude mcp add --transport http vaubaan '([^']+)'/.exec(line) ?? [];
  const [, key] = /--header 'Authorization: Bearer (vbn_live_[A-Za-z0-9_-]+)'/.exec(line) ?? [];
  expect(address).toBe(`${PUBLIC_URL}/mcp`);
  expect(key).toBeTruthy();
  agent = await connectAgent(key ?? '');
  await expect(kit.getByTestId('first-call-connected')).toBeVisible({ timeout: 15_000 });

  // ── 6. First call ────────────────────────────────────────────────────────
  actions.push('first call');
  const branches = await agent.call('github__list_branches', { owner: OWNER, repo: REPO });
  expect(branches.outcome).toBe('allowed');
  await expect(kit.getByTestId('first-call-arrived')).toContainText('github__list_branches', {
    timeout: 15_000,
  });

  expect(actions).toEqual([
    'install the app',
    'first access',
    'connect an account',
    'create the mission',
    'add it to my agent',
    'first call',
  ]);
  expect(actions.length).toBeLessThanOrEqual(MOST_ACTIONS);
  // The screens of the path, and no other: the home, the services, GitHub's form, the mission.
  expect(screens).toEqual(['/', '/accounts/new', '/accounts/new/github', '/missions/new']);
});
