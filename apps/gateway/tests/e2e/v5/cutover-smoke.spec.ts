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

const TOKEN = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;
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
  await page.goto('/connections');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/auth/login?return_to=/connections');
  await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible();
  await expect(page.getByText(E2E_CUTOVER_USER.email)).toBeVisible();
  await expect(page.getByText('No connection yet.')).toBeVisible();

  // ── 2. Connect GitHub through the company's App ───────────────────────────
  await page.getByRole('link', { name: 'Connect a provider' }).first().click();
  await page.getByRole('link', { name: /^GitHub/ }).click();
  await expect(page.getByRole('heading', { name: 'GitHub', level: 1 })).toBeVisible();
  // The field's label is not bound to its input: reach it by its form name.
  await page.locator('input[name="name"]').fill(CONNECTION);
  // To the provider's installation page (mocked), and back with the
  // installation id, the user authorization code and the single-use state.
  await page.getByRole('button', { name: 'Continue to GitHub' }).click();
  await expect(page).toHaveURL(/\/connections\/[0-9a-f-]{36}(\?.*)?$/);
  await expect(page.getByRole('heading', { name: CONNECTION, level: 1 })).toBeVisible();
  await expect(page.getByText('active', { exact: true }).first()).toBeVisible();
  // The repositories of the installation were discovered as resources.
  for (const repository of MOCK_GITHUB.repositories) {
    await expect(page.getByRole('row', { name: new RegExp(repository) })).toBeVisible();
  }
  await snap(page, 'cutover-connection');
  const connected = await upstreamLog(request);
  expect(connected.calls.some((call) => call.url.includes('/user/installations'))).toBe(true);
  expect(connected.calls.some((call) => call.url.includes('/installation/repositories'))).toBe(
    true,
  );

  // ── 3. Issue a mission from the plugin's preset ───────────────────────────
  await page.goto('/missions/new');
  await page.getByLabel('Mission name').fill(MISSION);
  await page.getByLabel(`Include GitHub ${CONNECTION}`).check();
  await page
    .getByRole('group', { name: `Preset for GitHub ${CONNECTION}` })
    .getByRole('radio', { name: /^Developer\b/ })
    .check();
  await expect(page.getByTestId('summary-can')).toContainText(`GitHub "${CONNECTION}"`);
  // One code project, one repository: the other one is left out of the mission.
  await page.getByRole('button', { name: '2 of 2 resources' }).click();
  await page.getByLabel(`Resource ${LEFT_OUT}`).uncheck();
  await expect(page.getByTestId('summary-can')).toContainText('on 1 of 2 resources');
  await expect(page.getByTestId('summary-quantities')).toContainText('never expires');
  // The one adjustment: a quota small enough to run out in this test.
  // Custom mode opens the editor on the preset's values.
  await page
    .getByRole('group', { name: `Policy for GitHub ${CONNECTION}` })
    .getByRole('radio', { name: 'Custom' })
    .check();
  await page.getByLabel(`Quota for ${READ_CODE}`).fill(String(QUOTA));
  await page.getByRole('button', { name: 'Issue mission' }).click();

  // The bootstrap kit, revealed once: the token and the client configuration.
  const kit = page.getByRole('dialog');
  const token = TOKEN.exec(await kit.getByTestId('kit-env').innerText())?.[0];
  if (!token) throw new Error('no mission token in the bootstrap kit');
  await expect(kit.getByTestId('kit-mcp')).toContainText(`${PUBLIC_URL}/mcp`);
  await expect(kit.getByTestId('kit-mcp')).not.toContainText(token);
  await expect(kit.getByTestId('kit-verify')).toContainText('tools/list');
  await expect(kit.getByTestId('kit-instructions')).toContainText(`\`${REPOSITORY}\``);
  await expect(kit.getByTestId('kit-instructions')).not.toContainText(`\`${LEFT_OUT}\``);
  await snap(page, 'cutover-bootstrap-kit');
  await page.getByRole('button', { name: 'I copied the token' }).click();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  const missionId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // ── 4. The agent: tools/list and tools/call over HTTP on /mcp ─────────────
  // The kit's verification first, as plain JSON-RPC; without the token, nothing.
  expect((await kitToolsList(null)).status).toBe(401);
  const listed = await kitToolsList(token);
  expect(listed.status).toBe(200);
  expect(listed.tools).toContain('github__list_branches');
  expect(listed.tools.every((name) => name.startsWith('github__'))).toBe(true);

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
  expect(branchCalls[0]?.with_installation_token).toBe(true);
  expect(first.text).not.toContain(upstream.installation_token);

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
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: `Claim on ${MISSION}` })).toBeVisible();
  await expect(page.getByTestId('claim-budget')).toHaveText(
    `quota ${QUOTA} · consumed ${QUOTA} · 0 left`,
  );
  await expect(page.getByTestId('open-request-count')).toHaveText('1');
  await snap(page, 'cutover-claim');
  // The creator grants: one more action on this risk, for the current period.
  await page.getByLabel('Actions to give back').fill('1');
  await page.getByRole('button', { name: 'Extend the quota' }).click();
  await expect(page.getByText('Decision recorded')).toBeVisible();
  await expect(page.getByText('granted', { exact: true })).toBeVisible();
  await expect(page.getByTestId('open-request-count')).toHaveCount(0);

  // ── 7. The replay passes, with the same token ─────────────────────────────
  expect(await listBranches()).toMatchObject({ outcome: 'allowed' });
  // One action was given back, not more.
  expect(await listBranches()).toMatchObject({
    outcome: 'refused',
    refusal: { code: 'budget-exhausted' },
  });

  // ── 8. The calls on the Audit page ────────────────────────────────────────
  await page.goto(`/audit?mission=${missionId}`);
  await expect(page.getByRole('heading', { name: 'Audit', level: 1 })).toBeVisible();
  const entries = page.locator('table tbody tr');
  const calls = entries.filter({ hasText: 'github__list_branches' });
  // Three allowed, one outside the mission, two refused on the budget.
  await expect(calls).toHaveCount(6);
  await expect(calls.filter({ hasText: 'budget-exhausted' })).toHaveCount(2);
  await expect(calls.filter({ hasText: 'resource-not-in-mission' })).toHaveCount(1);
  await expect(calls.filter({ hasText: `agent ${AGENT_LABEL}` })).toHaveCount(6);
  await expect(entries.filter({ hasText: PROTECTED_WRITE })).toContainText('risk-not-accepted');
  await expect(entries.filter({ hasText: 'mission-issued' })).toHaveCount(1);
  await expect(calls.first().getByTestId('arguments-hash')).toHaveText(/^[0-9a-f]{64}$/);
  // Neither the mission token nor the provider's credential is on the page.
  const auditHtml = await page.content();
  expect(auditHtml).not.toContain(token);
  expect(auditHtml).not.toContain(upstream.installation_token);
  await snap(page, 'cutover-audit');

  // ── 9. …and on the mission's session page ─────────────────────────────────
  await page.goto(`/missions/${missionId}`);
  await page.getByRole('link', { name: 'Session', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/session$`));
  const budget = page.locator('table').nth(0);
  const readCode = budget.locator('tr', { hasText: READ_CODE });
  await expect(readCode).toContainText('exhausted');
  await expect(readCode.locator('td').nth(3)).toContainText('0');
  await expect(page.locator('dd', { hasText: AGENT_LABEL })).toBeVisible();
  const timeline = page.locator('table').last();
  // The session holds what went through the budget: three allowed calls with
  // what was left after each, the two refusals, and the creator's decision.
  await expect(timeline.locator('tr', { hasText: 'call-allowed' })).toHaveCount(3);
  await expect(timeline.locator('tr', { hasText: 'call-allowed' }).last()).toContainText(
    `${READ_CODE} → 1`,
  );
  await expect(timeline.locator('tr', { hasText: 'call-refused' })).toHaveCount(2);
  await expect(timeline.locator('tr', { hasText: 'call-refused' }).first()).toContainText(
    'budget-exhausted',
  );
  await expect(timeline.locator('tr', { hasText: '+1 given back' })).toContainText(
    E2E_CUTOVER_USER.email,
  );
  // The last refusal opened a claim of its own: the first one is closed.
  await expect(timeline.getByRole('link', { name: 'open claim' }).first()).toBeVisible();
  await snap(page, 'cutover-session');
});
