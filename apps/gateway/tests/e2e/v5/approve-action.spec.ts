/**
 * "Approve an action" in a browser, against an ephemeral instance with a
 * simulated IdP and a mocked GitHub (spec §7.7, §3.5, §4.1 `approval-required`,
 * §4.2 "Request inbox"; plan P2.1).
 *
 * The mission is issued from the GitHub plugin's `developer` preset as it
 * ships: writing a workflow file is one of its entries gated `approval`. The
 * executor is an MCP client holding the mission token; its calls go over HTTP
 * on `/mcp`, through the real execution door.
 *
 *   the call is refused with the approval request's URL → someone else opens
 *   it (403, nothing) → the creator reads the tool, the arguments in clear,
 *   the slices and the budget, and approves → the identical replay reaches the
 *   provider → the same call again asks again → the creator opens the gate for
 *   the rest of the period → then edits the gate on the mission page.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent, type CallOutcome, type Refusal } from './agent';
import { issueDeveloperMission, routeToInstance, signInAs, upstreamLog } from './browser';
import { E2E_APPROVER_USER, E2E_OTHER_USER, MOCK_GITHUB, PUBLIC_URL } from './instance';

const MISSION = 'Develop the app repository';
const TOOL = 'github__create_or_update_file';
const GATED = 'github.workflow-write-via-file';
const UNGATED = 'github.feature-branch-write';
/** In the arguments, and nowhere else once the request is decided. */
const MARKER = 'WORKFLOW-BODY-MARKER-3b9f';
const [OWNER, REPO] = (MOCK_GITHUB.repositories[0] ?? '').split('/');
const WORKFLOW = {
  owner: OWNER,
  repo: REPO,
  branch: 'feature/ci',
  path: '.github/workflows/ci.yml',
  message: 'ci: add the pipeline',
  content: `name: ci\non: push\n# ${MARKER}\n`,
};
const REQUEST_URL = new RegExp(`^${PUBLIC_URL}/r/[0-9a-f-]{36}$`);

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await routeToInstance(context);
  return context.newPage();
}

function approvalRequired(outcome: CallOutcome): Refusal {
  if (outcome.outcome !== 'refused') throw new Error('the gated call was allowed');
  expect(outcome.refusal.code).toBe('approval-required');
  return outcome.refusal;
}

let agent: Agent | null = null;

test.beforeEach(async ({ request }) => {
  // The scenario changes hands twice; it starts with nobody in particular.
  await signInAs(request, E2E_OTHER_USER);
});
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('a gated action of the developer preset: refused, approved by its creator only, replayed once', async ({
  browser,
  request,
}) => {
  const issued = await issueDeveloperMission(request, MISSION);
  const executor = (agent = await connectAgent(issued.token));
  const write = (args: Record<string, unknown> = WORKFLOW) => executor.call(TOOL, args);
  const workflowWrites = async () =>
    (await upstreamLog(request)).calls.filter((call) => call.method === 'PUT');
  const writesBefore = (await workflowWrites()).length;

  // ── The refusal ─────────────────────────────────────────────────────────
  const refusal = approvalRequired(await write());
  expect(refusal.risk_id).toBe(GATED);
  expect(refusal.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const approvalUrl = String(refusal.approval_url);
  expect(approvalUrl).toMatch(REQUEST_URL);
  expect(refusal.approval_valid_seconds).toBe(600);
  expect(Date.parse(String(refusal.expires_at))).toBeGreaterThan(Date.now());
  expect(refusal.hint).toContain(approvalUrl);
  expect(refusal.hint).toContain('exactly the same arguments');
  expect(JSON.stringify(refusal)).not.toContain(MARKER);
  // Nothing was executed and nothing is held: the provider saw no write.
  expect(await workflowWrites()).toHaveLength(writesBefore);
  // A replay before the decision points to the same request.
  expect(approvalRequired(await write()).approval_url).toBe(approvalUrl);

  // ── Someone else opens the forwarded URL ────────────────────────────────
  await signInAs(request, E2E_OTHER_USER);
  const bob = await freshPage(browser);
  await bob.goto('/auth/login?return_to=/missions');
  await expect(bob.getByText(E2E_OTHER_USER.email)).toBeVisible();
  const refused = await bob.goto(approvalUrl);
  expect(refused?.status()).toBe(403);
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  for (const detail of [MARKER, TOOL, MISSION, GATED, WORKFLOW.path]) {
    expect(await bob.content()).not.toContain(detail);
  }
  await bob.goto(approvalUrl.replace('/r/', '/requests/'));
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  for (const detail of [MARKER, TOOL, MISSION]) expect(await bob.content()).not.toContain(detail);
  await bob.goto('/requests');
  await expect(bob.getByText('Nothing awaits you.')).toBeVisible();
  await bob.context().close();

  // ── The creator opens it, not signed in yet ─────────────────────────────
  await signInAs(request, E2E_APPROVER_USER);
  const hedy = await freshPage(browser);
  await hedy.goto(approvalUrl);
  await expect(hedy).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(hedy.getByRole('heading', { name: `Approval request on ${MISSION}` })).toBeVisible();
  await expect(hedy.getByText(E2E_APPROVER_USER.email)).toBeVisible();

  // The tool, the arguments in clear, the slices, the budget of what the call touches.
  await expect(hedy.getByTestId('approval-tool')).toHaveText(TOOL);
  const shown = hedy.getByTestId('approval-arguments');
  await expect(shown).toContainText(MARKER);
  await expect(shown).toContainText('"path": ".github/workflows/ci.yml"');
  await expect(shown).toContainText('"branch": "feature/ci"');
  await expect(hedy.getByTestId('approval-fingerprint')).toHaveText(String(refusal.fingerprint));
  await expect(hedy.getByTestId('approval-slices')).toContainText('workflow-via-file.W');
  await expect(hedy.getByTestId('approval-slices')).toContainText(
    `github.repo[${OWNER}/${REPO}].branch[feature/ci].file[.github/workflows/ci.yml].W`,
  );
  await expect(hedy.getByTestId('approval-gate')).toHaveText('approval: each action asks you');
  const gatedRow = hedy.getByTestId(`approval-risk-${GATED}`);
  await expect(gatedRow.locator('td').nth(1)).toHaveText('approval');
  await expect(gatedRow.locator('td').nth(2)).toHaveText('50');
  await expect(gatedRow.locator('td').nth(4)).toHaveText('50');
  // The whole call is what is refused: the ungated risk it touches is listed too.
  const ungatedRow = hedy.getByTestId(`approval-risk-${UNGATED}`);
  await expect(ungatedRow.locator('td').nth(1)).toHaveText('auto');
  await expect(ungatedRow.locator('td').nth(4)).toHaveText('3000');
  await expect(
    hedy.getByRole('row', { name: new RegExp(`Refused ${TOOL} \\(approval-required\\)`) }).first(),
  ).toBeVisible();

  // Three actions, each with its consequence in one line.
  await expect(hedy.getByTestId('action-grant')).toContainText('once, within 10 minutes');
  await expect(hedy.getByTestId('action-grant')).toContainText(
    'counts against the quota and the rate limit',
  );
  await expect(hedy.getByTestId('action-open-gate')).toContainText('until the period ends');
  await expect(hedy.getByTestId('action-refuse')).toContainText('Nothing runs');
  await snap(hedy, 'approval-creator-view');

  // The inbox shows it, with its tool, without any forwarded URL.
  await expect(hedy.getByTestId('open-request-count')).toHaveText('1');
  await hedy
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Requests/ })
    .click();
  const inboxRow = hedy.getByRole('row', { name: new RegExp(MISSION) });
  await expect(inboxRow).toContainText(TOOL);
  await expect(inboxRow).toContainText(GATED);
  // The list names the tool; the arguments are on the request's own page only.
  // (Reloaded first: after an in-app navigation the document still holds the data
  // of the page the creator just left.)
  await hedy.reload();
  await expect(inboxRow).toContainText(TOOL);
  expect(await hedy.content()).not.toContain(MARKER);
  await snap(hedy, 'approval-inbox');
  await inboxRow.getByRole('link', { name: 'Approval request' }).click();
  await expect(hedy.getByRole('heading', { name: `Approval request on ${MISSION}` })).toBeVisible();

  // ── The grant ───────────────────────────────────────────────────────────
  await hedy.getByRole('button', { name: 'Approve this action' }).click();
  await expect(hedy.getByText('Decision recorded')).toBeVisible();
  await expect(hedy.getByText('granted', { exact: true })).toBeVisible();
  await expect(hedy.getByRole('button', { name: 'Approve this action' })).toHaveCount(0);
  await expect(hedy.getByTestId('approval-outcome')).toContainText('approval usable once until');
  // Decided: the arguments are erased, only their fingerprint remains.
  await expect(hedy.getByTestId('approval-arguments-erased')).toBeVisible();
  await expect(hedy.getByTestId('approval-arguments')).toHaveCount(0);
  await expect(hedy.getByTestId('approval-fingerprint')).toHaveText(String(refusal.fingerprint));
  expect(await hedy.content()).not.toContain(MARKER);
  await expect(hedy.getByTestId('open-request-count')).toHaveCount(0);
  await snap(hedy, 'approval-granted');

  // ── The identical replay passes, once ───────────────────────────────────
  const replay = await write({ ...WORKFLOW });
  if (replay.outcome !== 'allowed') throw new Error(`refused: ${replay.refusal.code}`);
  const afterReplay = await workflowWrites();
  expect(afterReplay).toHaveLength(writesBefore + 1);
  expect(afterReplay.at(-1)?.url).toContain(`/repos/${OWNER}/${REPO}/contents/`);
  expect(afterReplay.at(-1)?.with_installation_token).toBe(true);

  await hedy.reload();
  await expect(hedy.getByTestId('approval-outcome')).toContainText(
    'approval consumed by the replay',
  );
  // The approved action counted against both risks it touches.
  await expect(gatedRow.locator('td').nth(3)).toHaveText('1');
  await expect(gatedRow.locator('td').nth(4)).toHaveText('49');
  await expect(ungatedRow.locator('td').nth(4)).toHaveText('2999');

  // The same call again: the approval was single-use, a new request is dropped.
  const second = approvalRequired(await write());
  expect(second.approval_url).not.toBe(approvalUrl);
  expect(second.fingerprint).toBe(refusal.fingerprint);
  // One byte changed: another call, another fingerprint, another request.
  const changed = { ...WORKFLOW, content: `${WORKFLOW.content} ` };
  const third = approvalRequired(await write(changed));
  expect(third.fingerprint).not.toBe(refusal.fingerprint);
  expect(third.approval_url).not.toBe(second.approval_url);
  expect(await workflowWrites()).toHaveLength(writesBefore + 1);
  await hedy.reload();
  await expect(hedy.getByTestId('open-request-count')).toHaveText('2');

  // ── Open the gate for the rest of the period ────────────────────────────
  await hedy.goto(String(third.approval_url));
  await expect(hedy).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(hedy.getByTestId('approval-arguments')).toContainText(MARKER);
  await hedy.getByRole('button', { name: 'Open the gate for the rest of the period' }).click();
  await expect(hedy.getByText('Decision recorded')).toBeVisible();
  await expect(hedy.getByTestId('approval-gate')).toContainText('approval, open until');
  await expect(hedy.getByTestId('approval-arguments-erased')).toBeVisible();
  await snap(hedy, 'approval-gate-opened');
  // Any call on the risk passes now, within the budget; the request left open says so.
  expect(await write(changed)).toMatchObject({ outcome: 'allowed' });
  expect(await write()).toMatchObject({ outcome: 'allowed' });
  expect(await workflowWrites()).toHaveLength(writesBefore + 3);
  await hedy.goto(String(second.approval_url));
  await expect(hedy.getByTestId('action-open-gate')).toContainText('already open for this period');
  await expect(
    hedy.getByRole('button', { name: 'Open the gate for the rest of the period' }),
  ).toBeDisabled();
  await hedy.getByRole('button', { name: 'Refuse' }).click();
  await expect(hedy.getByText('refused', { exact: true })).toBeVisible();
  await expect(hedy.getByTestId('open-request-count')).toHaveCount(0);

  // ── The gate, edited on the mission page after issuance ─────────────────
  await hedy.goto(`/missions/${issued.mission_id}`);
  const gateCell = hedy.getByTestId(`gate-${GATED}`);
  await expect(gateCell).toContainText('approval');
  await expect(gateCell).toContainText('open until');
  await snap(hedy, 'mission-gate-open');
  // To `auto`: the opening is over, the policy itself lets the calls through.
  await gateCell.getByRole('button', { name: `Set to auto for ${GATED}` }).click();
  await expect(
    gateCell.getByRole('button', { name: `Require approval for ${GATED}` }),
  ).toBeVisible();
  await expect(gateCell).not.toContainText('open until');
  expect(await write({ ...WORKFLOW, message: 'ci: tune' })).toMatchObject({ outcome: 'allowed' });
  // Back to `approval`: the next call asks again, although the period has not ended.
  await gateCell.getByRole('button', { name: `Require approval for ${GATED}` }).click();
  await expect(gateCell.getByRole('button', { name: `Set to auto for ${GATED}` })).toBeVisible();
  await expect(gateCell).not.toContainText('open until');
  approvalRequired(await write({ ...WORKFLOW, message: 'ci: tune again' }));
  expect(await workflowWrites()).toHaveLength(writesBefore + 4);
  await snap(hedy, 'mission-gate-edited');

  // ── What the audit keeps: the acts and the fingerprint, never the arguments ──
  await hedy.goto(`/audit?mission=${issued.mission_id}`);
  await expect(hedy.getByRole('heading', { name: 'Audit', level: 1 })).toBeVisible();
  const entries = hedy.locator('table tbody tr');
  await expect(entries.filter({ hasText: 'approval-granted' })).toHaveCount(1);
  await expect(entries.filter({ hasText: 'gate-opened' })).toHaveCount(1);
  await expect(entries.filter({ hasText: 'request-refused' })).toHaveCount(1);
  await expect(entries.filter({ hasText: 'gate-changed' })).toHaveCount(2);
  await expect(entries.filter({ hasText: 'approval consumed' })).toHaveCount(1);
  await expect(entries.filter({ hasText: 'approval-required' }).first()).toContainText(TOOL);
  expect(await hedy.content()).not.toContain(MARKER);
  await snap(hedy, 'approval-audit');

  // …and the session: the decisions are on the timeline, without the arguments.
  await hedy.goto(`/missions/${issued.mission_id}/session`);
  const timeline = hedy.locator('table').last();
  await expect(timeline.locator('tr', { hasText: 'gate-opened' })).toHaveCount(1);
  await expect(timeline.locator('tr', { hasText: 'gate-changed' })).toHaveCount(2);
  await expect(timeline.locator('tr', { hasText: 'call-allowed' })).toHaveCount(4);
  expect(await hedy.content()).not.toContain(MARKER);
  await hedy.context().close();
});
