/**
 * The cutover smoke: the whole path of the cutover acceptance scenario
 * (`docs/tests/e2e-tests.md`, ADR pivot-v4-to-v5 D7, spec §10 "End to end") on
 * an ephemeral instance, with the simulated IdP and a mocked GitHub.
 *
 *   sign in through the IdP → connect GitHub through the company's App →
 *   issue a mission from the plugin's `developer` preset → an MCP client lists
 *   the tools and calls one over HTTP on `/mcp` with the mission token → a
 *   quota runs out → the refusal's claim URL → the creator grants → the replay
 *   passes → the calls show on the Audit page and on the mission's session.
 *
 * What it is not: no real identity provider, no real provider, no Claude Code.
 * Those three are the manual scenario's.
 */
import { expect, test, type Page } from '@playwright/test';

import { connectAgent, kitToolsList, type Agent } from './agent';
import { routeToInstance, signInAs, upstreamLog } from './browser';
import { E2E_CUTOVER_USER, MOCK_GITHUB, PUBLIC_URL } from './instance';
import {
  createMission,
  openCreatedMission,
  pickCran,
  resourcesButton,
  showView,
} from './mission-pages';

const CONNECTION = 'Cutover org';
const MISSION = 'Cutover — acme/app';
const READ_CODE = 'github.read-code';
/** The quota the creator leaves on `github.read-code`, so the smoke can spend it. */
const QUOTA = 2;
/** The repository the mission may touch, and the one the creator leaves out. */
const [REPOSITORY, LEFT_OUT] = MOCK_GITHUB.repositories;
const [OWNER, REPO] = REPOSITORY.split('/');
const AGENT_LABEL = 'cutover-agent';
/** A write on the default branch: a risk the `developer` preset does not accept. */
const PROTECTED_WRITE = 'github__create_or_update_file';

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

let agent: Agent | null = null;

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_CUTOVER_USER);
});
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('cutover smoke: sign in, connect, issue, call through the door, exhaust, claim, replay, audit', async ({
  page,
  request,
}) => {
  // ── 1. Sign in through the identity provider ──────────────────────────────
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/auth/login?return_to=/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(page.getByText(E2E_CUTOVER_USER.email)).toBeVisible();
  // Nothing yet: one sentence, and the services to connect right under it.
  await expect(page.getByTestId('accounts-empty')).toContainText('No account yet.');

  // ── 2. Connect GitHub with a fine-grained token ───────────────────────────
  await page.getByRole('link', { name: 'Connect an account' }).click();
  await expect(page).toHaveURL(/\/accounts#connect$/);
  // Every service says how it is connected; none waits for an administrator
  // (Gmail takes an app password, ADR gmail-over-imap-with-an-app-password).
  await expect(page.getByTestId('service-gmail')).toContainText('paste:');
  await expect(page.getByTestId('service-railway')).toContainText('workspace token');
  await page.getByTestId('service-github').getByRole('link').click();
  await expect(
    page.getByRole('heading', { name: 'Connect a GitHub account', level: 1 }),
  ).toBeVisible();
  // The guide the plugin declares: where to create the token, the permissions to tick.
  await expect(page.getByTestId('token-guide')).toContainText('Create the token at GitHub');
  await expect(page.getByTestId('token-permissions')).toContainText('Contents');
  await page.getByLabel(/^Name/).fill(CONNECTION);
  // The token is checked at the mocked GitHub, then stored; it is never shown again.
  await page.getByLabel(/Fine-grained personal access token/).fill(MOCK_GITHUB.token);
  await page.getByRole('button', { name: 'Check and connect' }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}(\?.*)?$/);
  await expect(page.getByRole('heading', { name: CONNECTION, level: 1 })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  // The normal state is not labelled; the header says whose it is.
  await expect(page.getByText('you own it').first()).toBeVisible();
  // The repositories the token reaches were found as resources.
  for (const repository of MOCK_GITHUB.repositories) {
    await expect(
      page.getByTestId('account-resources').getByRole('row', { name: new RegExp(repository) }),
    ).toBeVisible();
  }
  // No mission uses it yet, and nobody else holds it.
  await expect(page.getByTestId('account-missions')).toContainText('No mission uses this account');
  await expect(page.getByTestId('who-has-access').getByRole('row')).toHaveCount(2);
  await snap(page, 'cutover-connection');
  const connected = await upstreamLog(request);
  expect(connected.calls.some((call) => call.url.endsWith('/user'))).toBe(true);
  expect(connected.calls.some((call) => call.url.includes('/user/repos'))).toBe(true);
  expect(await page.content()).not.toContain(MOCK_GITHUB.token);

  // ── 3. Issue a mission from the plugin's macro-actions ────────────────────
  await page.goto('/missions/new');
  await page.getByLabel('Mission name').fill(MISSION);
  await page.getByLabel(`Include GitHub ${CONNECTION}`).check();
  await pickCran(page, `GitHub ${CONNECTION}`, 'Read', 'Confiant');
  await pickCran(page, `GitHub ${CONNECTION}`, 'Propose', 'Prudent');
  await expect(page.getByTestId('summary-github')).toContainText('permissions.');
  // One code project, one repository: the other one is left out of the mission.
  await resourcesButton(page, `GitHub ${CONNECTION}`, '2 of 2').click();
  await page.getByLabel(`Resource ${LEFT_OUT}`).uncheck();
  await expect(resourcesButton(page, `GitHub ${CONNECTION}`, '1 of 2')).toBeVisible();
  await expect(page.getByTestId('summary-github')).toContainText('Nor the other 1 resource.');
  await expect(page.getByTestId('summary-carries')).toContainText('never expires');
  // The one adjustment: a limit small enough to be reached in this test.
  // The advanced view opens on the lines the crans wrote.
  await showView(page, `GitHub ${CONNECTION}`, 'Advanced');
  await page.getByLabel(`Limit for ${READ_CODE}`).fill(String(QUOTA));

  // The key, shown once, with the kit: the client configuration and the instructions.
  const token = await createMission(page);
  const kit = page.getByTestId('created');
  await expect(kit.getByTestId('kit-mcp')).toContainText(`${PUBLIC_URL}/mcp`);
  await expect(kit.getByTestId('kit-mcp')).not.toContainText(token);
  await expect(kit.getByTestId('kit-verify')).toContainText('tools/list');
  await expect(kit.getByTestId('kit-instructions')).toContainText(`\`${REPOSITORY}\``);
  await expect(kit.getByTestId('kit-instructions')).not.toContainText(`\`${LEFT_OUT}\``);
  await snap(page, 'cutover-bootstrap-kit');
  await openCreatedMission(page, MISSION);
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  const missionId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // ── 4. The agent: tools/list and tools/call over HTTP on /mcp ─────────────
  // The kit's verification first, as plain JSON-RPC; without the token, nothing.
  expect((await kitToolsList(null)).status).toBe(401);
  const listed = await kitToolsList(token);
  expect(listed.status).toBe(200);
  expect(listed.tools).toContain('github__list_branches');
  expect(listed.tools).toContain('vaubaan__request_permission');
  expect(
    listed.tools.every(
      (name) => name.startsWith('github__') || name === 'vaubaan__request_permission',
    ),
  ).toBe(true);

  // Then an MCP client, as a coding agent's runtime connects.
  const executor = (agent = await connectAgent(token, AGENT_LABEL));
  expect(await executor.listTools()).toEqual(listed.tools);
  const listBranches = () => executor.call('github__list_branches', { owner: OWNER, repo: REPO });

  const first = await listBranches();
  if (first.outcome !== 'allowed') throw new Error(`refused: ${first.refusal.code}`);
  expect(JSON.parse(first.text)).toEqual(MOCK_GITHUB.branches);
  // The gateway called the provider with a credential of its own, which the agent never saw.
  const upstream = await upstreamLog(request);
  const branchCalls = upstream.calls.filter((call) =>
    call.url.includes(`/repos/${REPOSITORY}/branches`),
  );
  expect(branchCalls).toHaveLength(1);
  expect(branchCalls[0]?.with_connection_token).toBe(true);
  expect(first.text).not.toContain(upstream.connection_token);

  // The two refusals a day of work may meet without anything being wrong:
  // a resource outside the mission, a risk the creator did not accept.
  const outside = await executor.call('github__list_branches', {
    owner: LEFT_OUT.split('/')[0],
    repo: LEFT_OUT.split('/')[1],
  });
  expect(outside).toMatchObject({
    outcome: 'refused',
    refusal: {
      code: 'resource-not-in-mission',
      cited_ref: LEFT_OUT,
      allowed_resources: [{ ref: REPOSITORY }],
    },
  });
  const notAccepted = await executor.call(PROTECTED_WRITE, {
    owner: OWNER,
    repo: REPO,
    path: 'README.md',
    content: 'pushed straight to main',
    message: 'docs: straight to main',
    branch: 'main',
  });
  if (notAccepted.outcome !== 'refused') throw new Error('a write on main was allowed');
  expect(notAccepted.refusal.code).toBe('risk-not-accepted');
  expect((notAccepted.refusal.missing_risks as string[]).length).toBeGreaterThan(0);

  // ── 5. The quota runs out ─────────────────────────────────────────────────
  expect(await listBranches()).toMatchObject({ outcome: 'allowed' });
  const exhausted = await listBranches();
  if (exhausted.outcome !== 'refused') throw new Error('the budget never refused');
  expect(exhausted.refusal).toMatchObject({ code: 'budget-exhausted', risk_id: READ_CODE });
  const claimUrl = String(exhausted.refusal.claim_url);
  expect(claimUrl).toMatch(new RegExp(`^${PUBLIC_URL}/r/[0-9a-f-]{36}$`));
  expect(exhausted.refusal.hint).toContain(claimUrl);
  // A refused call never reaches the provider.
  const afterRefusal = await upstreamLog(request);
  expect(
    afterRefusal.calls.filter((call) => call.url.includes(`/repos/${REPOSITORY}/branches`)),
  ).toHaveLength(QUOTA);

  // ── 6. The claim URL, opened by the creator ───────────────────────────────
  await expect(page.getByTestId('open-request-count')).toHaveCount(0);
  await page.goto(claimUrl);
  await expect(page).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('request-statement')).toContainText(
    `on ${MISSION} reached a limit`,
  );
  await expect(page.getByTestId('claim-budget')).toContainText(`${QUOTA} of ${QUOTA}`);
  await expect(page.getByTestId('open-request-count')).toHaveText('1');
  await snap(page, 'cutover-claim');
  // The creator grants: one more action on this risk, for the current period.
  await page.getByTestId('answer-extend-quota').getByRole('radio').check();
  await page.getByLabel('Calls to give back').fill('1');
  await page.getByRole('button', { name: 'Give back 1 call' }).click();
  await expect(page.getByTestId('request-decided')).toBeVisible();
  await expect(page.getByTestId('request-state')).toHaveText('answered');
  await expect(page.getByTestId('open-request-count')).toHaveCount(0);

  // ── 7. The replay passes, with the same token ─────────────────────────────
  expect(await listBranches()).toMatchObject({ outcome: 'allowed' });
  // One action was given back, not more.
  expect(await listBranches()).toMatchObject({
    outcome: 'refused',
    refusal: { code: 'budget-exhausted' },
  });

  // ── 8. The calls on the Audit page ────────────────────────────────────────
  await page.goto(`/activity?mission=${missionId}`);
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  const calls = entries.filter({ hasText: 'github__list_branches' });
  // Three allowed, one outside the mission, two refused on the limit.
  await expect(calls).toHaveCount(6);
  await expect(calls.filter({ hasText: 'limit reached' })).toHaveCount(2);
  await expect(calls.filter({ hasText: 'resource not in this mission' })).toHaveCount(1);
  await expect(calls.filter({ hasText: AGENT_LABEL })).toHaveCount(6);
  await expect(entries.filter({ hasText: PROTECTED_WRITE })).toContainText(
    'permission not in this mission',
  );
  await expect(entries.filter({ hasText: 'created a mission' })).toHaveCount(1);
  // The fingerprint of the arguments is in the detail of a line, for who answers for the call.
  await calls.first().getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('arguments-hash')).toHaveText(/^[0-9a-f]{64}$/);
  // Neither the mission token nor the provider's credential is on the page.
  const auditHtml = await page.content();
  expect(auditHtml).not.toContain(token);
  expect(auditHtml).not.toContain(upstream.connection_token);
  await snap(page, 'cutover-audit');

  // ── 9. …and on the mission's session page ─────────────────────────────────
  await page.goto(`/missions/${missionId}`);
  // The mission says its limit is reached, beside its title and in its summary.
  await expect(page.getByTestId('mission-allows')).toContainText('Limit reached');
  await page.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/session$`));
  const permissions = page.getByTestId('session-permissions');
  await permissions.getByRole('button', { name: /^All \d+ permissions?/ }).click();
  const readCode = permissions.locator(`tr[data-permission="${READ_CODE}"]`);
  await expect(readCode).toContainText('Limit reached');
  await expect(page.getByTestId('label-activity')).toContainText(AGENT_LABEL);
  const timeline = page.getByTestId('timeline').locator('table');
  const outcome = (words: string) =>
    timeline.locator('tbody tr').filter({ has: page.getByText(words, { exact: true }) });
  // The activity holds what was counted: three allowed calls with what was left
  // after each, the two refusals, and the creator's decision.
  await expect(outcome('allowed')).toHaveCount(3);
  await expect(outcome('allowed').last()).toContainText(READ_CODE);
  await expect(outcome('allowed').last()).toContainText('1 left');
  await expect(outcome('limit reached')).toHaveCount(2);
  await expect(outcome('limit reached').first()).toContainText('budget-exhausted');
  await expect(timeline.locator('tr', { hasText: '+1 given back' })).toContainText(
    E2E_CUTOVER_USER.email,
  );
  // The last refusal opened a claim of its own: the first one is closed.
  await expect(timeline.getByRole('link', { name: 'Review and answer' }).first()).toBeVisible();
  await snap(page, 'cutover-activity');
});
