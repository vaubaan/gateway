/**
 * "Approve an action" in a browser, against an ephemeral instance with a
 * simulated IdP and a mocked GitHub (spec §7.7, §3.5, §4.1 `approval-required`,
 * §4.2 "Request inbox").
 *
 * The mission is composed from the GitHub plugin's macro-actions as they ship:
 * Administer at Prudent gates writing a workflow file (palier 3) `approval`, at
 * its base budget of 50; Propose at Confiant runs the feature-branch write
 * freely, at three times its base budget of 500. The
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
import { permissionRow, showPermissions } from './mission-pages';

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

/** Opens "the fingerprint and what the call touches" of a request page, unless it is open already. */
async function showCallDetails(page: Page): Promise<void> {
  const fingerprint = page.getByTestId('approval-fingerprint');
  await page.waitForLoadState('networkidle');
  if (!(await fingerprint.isVisible())) {
    await page.getByRole('button', { name: /^Show the fingerprint/ }).click();
  }
  await expect(fingerprint).toBeVisible();
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

test('a gated action of the developer trust levels: refused, approved by its creator only, replayed once', async ({
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
  await bob.goto(approvalUrl.replace('/r/', '/waiting/'));
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  for (const detail of [MARKER, TOOL, MISSION]) expect(await bob.content()).not.toContain(detail);
  await bob.goto('/waiting');
  await expect(bob.getByTestId('waiting-empty')).toContainText('Nothing waits for you.');
  await bob.context().close();

  // ── The creator opens it, not signed in yet ─────────────────────────────
  await signInAs(request, E2E_APPROVER_USER);
  const hedy = await freshPage(browser);
  await hedy.goto(approvalUrl);
  await expect(hedy).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  await expect(hedy.getByRole('heading', { name: 'Waiting for you', level: 1 })).toBeVisible();
  await expect(hedy.getByTestId('user-menu')).toContainText(E2E_APPROVER_USER.email);

  // Who asks and on which mission, then the call: the tool, the arguments in clear.
  const statement = hedy.getByTestId('request-statement');
  await expect(statement).toContainText(`on ${MISSION} wants to`);
  await expect(statement).toContainText('using your key');
  await expect(hedy.getByTestId('approval-tool')).toContainText(TOOL);
  const shown = hedy.getByTestId('approval-arguments');
  await expect(shown).toContainText(MARKER);
  await expect(shown).toContainText('.github/workflows/ci.yml');
  await expect(shown).toContainText('feature/ci');
  // The permission it needs, with its id as the protocol spells it, and what it asks.
  const needed = hedy.getByTestId('approval-gated-risks');
  await expect(needed).toContainText(GATED);
  await expect(hedy.getByTestId('approval-gate')).toHaveText('ask me first');
  await expect(needed.locator('[data-severity]')).toHaveCount(1);
  // What is left of every permission the call counts against, once it has run: the
  // whole call is what waits, so the one that runs freely is listed too.
  await expect(hedy.getByTestId(`approval-room-${GATED}`)).toContainText('49 of 50 left');
  await expect(hedy.getByTestId(`approval-room-${UNGATED}`)).toContainText('1,499 of 1,500 left');
  // The fingerprint and what the call touches are one click away.
  await showCallDetails(hedy);
  await expect(hedy.getByTestId('approval-fingerprint')).toHaveText(String(refusal.fingerprint));
  await expect(hedy.getByTestId('approval-slices')).toContainText('workflow-via-file.W');
  await expect(hedy.getByTestId('approval-slices')).toContainText(
    `github.repo[${OWNER}/${REPO}].branch[feature/ci].file[.github/workflows/ci.yml].W`,
  );
  const led = hedy.getByTestId('request-events');
  await expect(led).toContainText('was stopped on');
  await expect(led).toContainText(TOOL);
  await expect(led).toContainText('approval-required');
  // What the agent holds meanwhile: the refusal, with the link.
  await expect(hedy.getByTestId('agent-sees')).toContainText(approvalUrl);

  // Three answers; what each one does is said before the buttons.
  await expect(hedy.getByTestId('consequence-grant')).toContainText(
    'Valid 10 minutes, for exactly this call',
  );
  await expect(hedy.getByTestId('consequence-open-gate')).toContainText(
    'runs without asking you until',
  );
  await expect(hedy.getByTestId('consequence-refuse')).toContainText('Nothing runs');
  const answerOrder = await hedy.evaluate(() => {
    const said = document.querySelector('[data-testid="consequence-grant"]');
    const button = document.querySelector('[data-testid="action-grant"] button');
    return said && button
      ? Boolean(said.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
      : false;
  });
  expect(answerOrder).toBe(true);
  await snap(hedy, 'approval-creator-view');

  // The home shows it too, without the arguments; a yes is given on the request's page.
  await expect(hedy.getByTestId('open-request-count')).toHaveText('1');
  await hedy.goto('/');
  const waiting = hedy.getByTestId('now-waiting');
  await expect(waiting).toContainText(MISSION);
  // The head of the row is what the agent wants to do and on what — the plugin's words for
  // the tool, the resource the call resolved to — and the permission it needs comes after.
  await expect(waiting.getByTestId('call-headline')).toHaveText(
    'Write a file on a branch · acme/app',
  );
  await expect(waiting).toContainText('needs “Modify a GitHub Actions workflow');
  await expect(waiting).toContainText('An agent with your key, on');
  await expect(waiting.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  expect(await hedy.content()).not.toContain(MARKER);
  await snap(hedy, 'approval-on-now');

  // The inbox shows it without any forwarded URL: one list, the request open beside it.
  await hedy
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Waiting for you/ })
    .click();
  const inboxItem = hedy
    .getByTestId('waiting-list')
    .getByRole('link', { name: new RegExp(MISSION) });
  await expect(inboxItem).toHaveAttribute('aria-current', 'page');
  // The list never carries the arguments: they are in the open request only.
  expect(await hedy.getByTestId('waiting-list').innerHTML()).not.toContain(MARKER);
  await expect(hedy.getByTestId('approval-arguments')).toContainText(MARKER);
  await snap(hedy, 'approval-inbox');
  await inboxItem.click();
  await expect(hedy).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  await expect(hedy.getByTestId('request-statement')).toContainText(MISSION);

  // ── The grant ───────────────────────────────────────────────────────────
  await hedy.getByRole('button', { name: 'Approve this call' }).click();
  await expect(hedy.getByTestId('request-decided')).toBeVisible();
  await expect(hedy.getByTestId('request-state')).toHaveText('approved');
  await expect(hedy.getByRole('button', { name: 'Approve this call' })).toHaveCount(0);
  await expect(hedy.getByTestId('approval-outcome')).toContainText('Your yes is valid until');
  // Decided: the arguments are erased, only their fingerprint remains.
  await expect(hedy.getByTestId('approval-arguments-erased')).toBeVisible();
  await expect(hedy.getByTestId('approval-arguments')).toHaveCount(0);
  await showCallDetails(hedy);
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
  expect(afterReplay.at(-1)?.with_connection_token).toBe(true);

  await hedy.reload();
  await expect(hedy.getByTestId('approval-outcome')).toContainText('The agent ran it on');
  // The approved action counted against both permissions it touches.
  await expect(hedy.getByTestId(`approval-room-${GATED}`)).toContainText('49 of 50 left');
  await expect(hedy.getByTestId(`approval-room-${UNGATED}`)).toContainText('1,499 of 1,500 left');

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
  await expect(hedy).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  await expect(hedy.getByTestId('approval-arguments')).toContainText(MARKER);
  await hedy.getByRole('button', { name: 'Let it run freely until the reset' }).click();
  await expect(hedy.getByTestId('request-decided')).toBeVisible();
  await expect(hedy.getByTestId('approval-gate')).toContainText('runs freely until');
  await expect(hedy.getByTestId('approval-outcome')).toContainText(
    'You let it run freely until the limits reset',
  );
  await expect(hedy.getByTestId('approval-arguments-erased')).toBeVisible();
  await snap(hedy, 'approval-gate-opened');
  // Any call on the risk passes now, within the budget; the request left open says so.
  expect(await write(changed)).toMatchObject({ outcome: 'allowed' });
  expect(await write()).toMatchObject({ outcome: 'allowed' });
  expect(await workflowWrites()).toHaveLength(writesBefore + 3);
  await hedy.goto(String(second.approval_url));
  await expect(hedy.getByTestId('consequence-open-gate')).toContainText(
    'Not possible now: it already runs freely.',
  );
  await expect(
    hedy.getByRole('button', { name: 'Let it run freely until the reset' }),
  ).toBeDisabled();
  await hedy.getByRole('button', { name: 'Refuse' }).click();
  await expect(hedy.getByTestId('request-state')).toHaveText('refused');
  await expect(hedy.getByTestId('approval-outcome')).toContainText('Nothing ran');
  await expect(hedy.getByTestId('open-request-count')).toHaveCount(0);

  // ── While it runs freely for the period, the mission's activity says so too ──
  await hedy.goto(`/missions/${issued.mission_id}/session`);
  const sessionPermissions = hedy.getByTestId('session-permissions');
  await sessionPermissions.getByRole('button', { name: /^All \d+ permissions?/ }).click();
  const sessionGate = permissionRow(sessionPermissions, GATED);
  await expect(sessionGate).toContainText('ask me first');
  await expect(sessionGate).toContainText('runs freely until');
  // Nobody changes "ask me first" from the activity: it is read there.
  await expect(sessionPermissions.getByRole('switch')).toHaveCount(0);
  await snap(hedy, 'activity-runs-freely');

  // ── "Ask me first", changed on the mission page after creation ──────────
  await hedy.goto(`/missions/${issued.mission_id}`);
  const gateCell = permissionRow(await showPermissions(hedy), GATED);
  const askFirst = hedy.getByLabel(`ask me first: ${GATED}`);
  await expect(gateCell).toContainText('ask me first');
  await expect(gateCell).toContainText('runs freely until');
  await expect(askFirst).toBeChecked();
  await snap(hedy, 'mission-runs-freely');
  // Off: the opening is over, the permission itself lets the calls through.
  await askFirst.uncheck();
  await expect(askFirst).not.toBeChecked();
  await expect(gateCell).not.toContainText('runs freely until');
  await expect(gateCell).not.toContainText('ask me first');
  // The change is confirmed where the person looks, and says when it applies.
  await expect(hedy.getByTestId('toasts')).toContainText('runs freely');
  await expect(hedy.getByTestId('toasts')).toContainText('From the next call.');
  expect(await write({ ...WORKFLOW, message: 'ci: tune' })).toMatchObject({ outcome: 'allowed' });
  // On again: the next call asks again, although the period has not ended.
  await askFirst.check();
  await expect(askFirst).toBeChecked();
  await expect(gateCell).toContainText('ask me first');
  await expect(gateCell).not.toContainText('runs freely until');
  approvalRequired(await write({ ...WORKFLOW, message: 'ci: tune again' }));
  expect(await workflowWrites()).toHaveLength(writesBefore + 4);
  await snap(hedy, 'mission-gate-edited');

  // ── What the audit keeps: the acts and the fingerprint, never the arguments ──
  await hedy.goto(`/activity?mission=${issued.mission_id}`);
  await expect(hedy.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  // One line per call and per change, in words; the protocol's names are in a line's detail.
  const entries = hedy.getByTestId('audit-table').locator('tbody tr[data-row]');
  await expect(entries.filter({ hasText: 'approved a call' })).toHaveCount(1);
  await expect(
    entries.filter({ hasText: 'let a permission run freely for the period' }),
  ).toHaveCount(1);
  await expect(entries.filter({ hasText: 'refused a request' })).toHaveCount(1);
  await expect(entries.filter({ hasText: 'changed “ask me first”' })).toHaveCount(2);
  // The one call that used her yes says so on its line.
  await expect(entries.filter({ hasText: 'after a yes' })).toHaveCount(1);
  // A call that had to ask is not "refused" in red: it asked her.
  const asked = entries.filter({ hasText: 'asked you' });
  await expect(asked.first()).toContainText(TOOL);
  await asked.first().getByTestId('entry-detail-link').click();
  await expect(hedy.getByTestId('entry-detail')).toContainText('approval-required');
  expect(await hedy.content()).not.toContain(MARKER);
  await snap(hedy, 'approval-audit');

  // …and the activity of the mission: the decisions are on the timeline, without the arguments.
  await hedy.goto(`/missions/${issued.mission_id}/session`);
  // "Ask me first" was set again on the mission: the opening is over. The page remembered
  // that the permissions were open.
  const gateNow = permissionRow(hedy.getByTestId('session-permissions'), GATED);
  await expect(gateNow).toContainText('ask me first');
  await expect(gateNow).not.toContainText('runs freely until');
  const timeline = hedy.getByTestId('timeline');
  const events = (outcome: string) =>
    timeline.locator('tbody tr').filter({ has: hedy.getByText(outcome, { exact: true }) });
  // Each event says what it did, in the words of the interface.
  await expect(events('runs freely')).toHaveCount(1);
  await expect(events('runs freely')).toContainText('without asking until');
  await expect(events('set to “ask me first”')).toHaveCount(1);
  await expect(events('set to “ask me first”')).toContainText('was “runs freely”');
  await expect(events('set to “runs freely”')).toHaveCount(1);
  await expect(events('set to “runs freely”')).toContainText('was “ask me first”');
  await expect(events('allowed')).toHaveCount(4);
  await expect(events('approved')).toContainText('one call, usable until');
  await expect(events('allowed').filter({ hasText: 'after the creator’s yes' })).toHaveCount(1);
  await expect(events('refused by the creator')).toHaveCount(1);
  // The widest details of a timeline are on this one: the last column is on screen.
  const table = await hedy
    .getByTestId('timeline-table')
    .evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }));
  expect(table.content).toBeLessThanOrEqual(table.box);
  expect(await hedy.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await snap(hedy, 'activity-timeline-details');
  expect(await hedy.content()).not.toContain(MARKER);
  await hedy.context().close();
});

test('a call that touches two gated risks asks once: one request, one approval, one replay', async ({
  browser,
  request,
}) => {
  const issued = await issueDeveloperMission(request, 'Develop behind two gates');
  const executor = (agent = await connectAgent(issued.token));
  const workflowWrites = async () =>
    (await upstreamLog(request)).calls.filter((call) => call.method === 'PUT');
  const writesBefore = (await workflowWrites()).length;

  // The creator also gates the ordinary write on a working branch: writing a workflow
  // file there now touches two risks that wait for her.
  await signInAs(request, E2E_APPROVER_USER);
  const hedy = await freshPage(browser);
  await hedy.goto(`/auth/login?return_to=/missions/${issued.mission_id}`);
  await showPermissions(hedy);
  await hedy.getByLabel(`ask me first: ${UNGATED}`).check();
  await expect(hedy.getByLabel(`ask me first: ${UNGATED}`)).toBeChecked();
  await expect(hedy.getByTestId('toasts')).toContainText('asks you first');

  // ── One refusal, naming both risks, with one URL ────────────────────────
  const refusal = approvalRequired(await executor.call(TOOL, WORKFLOW));
  expect([...(refusal.risk_ids as string[])].sort()).toEqual([UNGATED, GATED].sort());
  const approvalUrl = String(refusal.approval_url);
  expect(approvalUrl).toMatch(REQUEST_URL);
  expect(refusal.hint).toContain(approvalUrl);
  // A replay before the decision points to the same request: there is only one.
  expect(approvalRequired(await executor.call(TOOL, WORKFLOW)).approval_url).toBe(approvalUrl);
  expect(await workflowWrites()).toHaveLength(writesBefore);

  // ── The creator reads both risks on one page, and answers once ──────────
  await hedy.goto(approvalUrl);
  await expect(hedy).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  const gated = hedy.getByTestId('approval-gated-risks');
  await expect(gated).toContainText('one answer for the 2');
  await expect(hedy.getByTestId('approval-permission')).toHaveCount(2);
  await expect(gated).toContainText(GATED);
  await expect(gated).toContainText(UNGATED);
  await expect(hedy.getByTestId('approval-gate')).toHaveText(['ask me first', 'ask me first']);
  await expect(hedy.getByTestId('consequence-grant')).toContainText(
    'One yes covers the 2 permissions this call needs.',
  );
  await snap(hedy, 'approval-two-gated-risks');

  // The inbox holds one item for the call, and the home one row.
  await hedy.goto('/waiting');
  const inboxItem = hedy
    .getByTestId('waiting-list')
    .getByRole('link', { name: /Develop behind two gates/ });
  await expect(inboxItem).toHaveCount(1);
  // One head for the call; the permissions it needs on the line under it.
  await expect(inboxItem.getByTestId('call-headline')).toHaveText(
    'Write a file on a branch · acme/app',
  );
  await expect(inboxItem).toContainText('and 1 more');
  await snap(hedy, 'approval-inbox-two-gated-risks');

  await hedy.goto(approvalUrl);
  await hedy.getByRole('button', { name: 'Approve this call' }).click();
  await expect(hedy.getByTestId('request-decided')).toBeVisible();
  await expect(hedy.getByTestId('request-state')).toHaveText('approved');

  // ── One replay passes; the approval was for that one call ───────────────
  expect(await executor.call(TOOL, { ...WORKFLOW })).toMatchObject({ outcome: 'allowed' });
  expect(await workflowWrites()).toHaveLength(writesBefore + 1);
  const again = approvalRequired(await executor.call(TOOL, WORKFLOW));
  expect(again.approval_url).not.toBe(approvalUrl);
  expect(await workflowWrites()).toHaveLength(writesBefore + 1);
  await hedy.reload();
  await expect(hedy.getByTestId('approval-outcome')).toContainText('The agent ran it on');
  await snap(hedy, 'approval-two-gated-risks-consumed');
  await hedy.context().close();
});
