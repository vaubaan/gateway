/**
 * The Mission session page and the Audit page in a browser, against an
 * ephemeral instance (spec §4.2, §8: "a day of
 * calls per mission with the remaining budget per call").
 *
 * The launcher issues a mission for the signed-in user and leaves a day of
 * calls on it: reads by two labelled agents, the pull-request quota spent and
 * a third one refused (a claim is open), a protected merge awaiting approval.
 */
import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, seedDay, signInAs } from './browser';
import { E2E_AUDIT_USER } from './instance';

/** What the seeded calls carried as an argument; it must never reach a page. */
const ARGUMENT_MARKER = 'RAW-ARGUMENT-MARKER-7f3a';

async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_AUDIT_USER);
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/auth/login?return_to=/missions');
  await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible();
  await expect(page.getByText(E2E_AUDIT_USER.email)).toBeVisible();
}

test('a day of calls: the mission, its activity, then the record of the mission', async ({
  page,
  request,
}) => {
  const day = await seedDay(request);
  await signIn(page);

  // ── The mission says what waits for an answer, with a link to answer ──────
  await page.goto(`/missions/${day.mission_id}`);
  await expect(page.getByTestId('mission-state')).toHaveText('Waiting for you');
  const waiting = page.getByTestId('mission-waiting');
  await expect(waiting).toContainText(/waiting for your yes|asks you for more room/);
  await expect(waiting.getByRole('link', { name: 'Review and answer' })).toHaveAttribute(
    'href',
    new RegExp(`^/waiting/(${day.claim_id}|${day.approval_id})$`),
  );
  await expect(page.getByText('And 1 request more on this mission')).toBeVisible();
  await expect(page.getByTestId('mission-allows')).toContainText('Limit reached');
  await snap(page, 'mission-waiting');

  // ── From the mission to its activity ──────────────────────────────────────
  await page.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session$`));
  await expect(page.getByRole('heading', { name: /^Activity of /, level: 1 })).toBeVisible();
  await expect(page.getByTestId('mission-state')).toHaveText('Waiting for you');

  // What waits: one row each, answered by link only.
  const requests = page.getByTestId('open-requests');
  await expect(requests.getByRole('listitem')).toHaveCount(2);
  await expect(requests.locator('a[data-request="claim"]')).toHaveAttribute(
    'href',
    `/waiting/${day.claim_id}`,
  );
  await expect(requests.locator('a[data-request="approval"]')).toHaveAttribute(
    'href',
    `/waiting/${day.approval_id}`,
  );

  // Every permission with what was used and what is left, one click away.
  const permissions = page.getByTestId('session-permissions');
  await permissions.getByRole('button', { name: /^All \d+ permissions?/ }).click();
  const row = (riskId: string) => permissions.locator(`tr[data-permission="${riskId}"]`);
  await expect(row('github.read-code')).toContainText('2 / 5');
  // A limit that is reached is a red meter that also says so in words.
  await expect(row('github.create-pr')).toContainText('2 / 2');
  await expect(row('github.create-pr')).toContainText('Limit reached');
  await expect(row('github.merge-protected').locator('[data-gate]')).toHaveText('ask me first');
  await expect(row('github.read-code').locator('[data-gate]')).toHaveText('runs freely');

  // What each period counted: the current one.
  const periods = page.getByTestId('session-periods');
  await periods.getByRole('button', { name: 'Show what each period counted' }).click();
  await expect(periods.locator('tbody tr')).toHaveCount(1);
  await expect(periods).toContainText('current');
  await expect(periods).toContainText('2 / 5');
  await expect(periods).toContainText('2 / 2');

  // Calls of the current period per agent label: counts, beside the shared limits.
  const activity = page.getByTestId('label-activity');
  await expect(activity).toContainText('not verified, and it decides nothing');
  await expect(activity.getByTestId('label-seen')).toHaveCount(2);
  await expect(activity.getByTestId('label-seen').filter({ hasText: 'planner' })).toContainText(
    '1 call',
  );
  const labelRow = (label: string) => activity.locator(`tr[data-row="${label}"]`);
  await expect(activity.locator('tbody tr')).toHaveCount(2);
  await expect(labelRow('coder').locator('td').nth(1)).toHaveText('3'); // allowed
  await expect(labelRow('coder').locator('td').nth(2)).toHaveText('2'); // refused
  await expect(labelRow('planner').locator('td').nth(1)).toHaveText('1');
  await expect(labelRow('planner').locator('td').nth(2)).toHaveText('0');

  // Timeline, newest first: the merge that asked first is on top.
  const timeline = page.getByTestId('timeline').locator('table');
  await expect(timeline.locator('tbody tr')).toHaveCount(8); // 6 calls + 2 requests
  await expect(timeline.locator('tbody tr').first()).toContainText('asked first');
  await expect(timeline.locator('tbody tr').first()).toContainText('approval-required');
  await expect(timeline.locator('tbody tr').last()).toContainText('github__get_file');
  await expect(timeline.locator('tbody tr').last()).toContainText('github.read-code');
  await expect(timeline.locator('tbody tr').last()).toContainText('4 left');
  // The refused call and the request it opened both lead to the page that answers it.
  await expect(timeline.locator(`a[href="/waiting/${day.claim_id}"]`)).toHaveCount(2);
  await expect(timeline.locator(`a[href="/waiting/${day.claim_id}"]`).first()).toHaveText(
    'Review and answer',
  );
  await expect(page.locator('body')).not.toContainText(ARGUMENT_MARKER);
  // The timeline is kept as long as the record, and the page says so.
  await expect(page.getByTestId('timeline-retention')).toContainText('kept 90 days');
  await snap(page, 'mission-activity');

  // The timeline of one label: its calls only; what was used does not move.
  await labelRow('planner').getByRole('link', { name: 'in the timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session\\?agent=planner$`));
  await expect(page.getByTestId('timeline-filter')).toContainText('planner');
  await expect(timeline.locator('tbody tr')).toHaveCount(1);
  await expect(timeline.locator('tbody tr').first()).toContainText('github__get_file');
  await expect(timeline.locator('tbody tr').first()).toContainText('planner');
  // The permissions stay open across the page's own links: the choice is remembered.
  await expect(row('github.read-code')).toContainText('2 / 5');
  await expect(labelRow('coder').locator('td').nth(1)).toHaveText('3');
  await snap(page, 'mission-activity-one-label');
  await page.getByRole('link', { name: 'Show the whole timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session$`));
  await expect(timeline.locator('tbody tr')).toHaveCount(8);

  // ── The audit of this mission ─────────────────────────────────────────────
  await page.getByRole('link', { name: 'Full record of this mission' }).click();
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/activity\\?mission=${day.mission_id}$`));
  const record = page.getByTestId('audit-table');
  const entries = record.locator('tbody tr[data-row]');
  // Six calls and the creation of the mission.
  await expect(entries).toHaveCount(7);
  await expect(page.getByLabel('Mission', { exact: true })).toHaveValue(day.mission_id);
  await expect(entries.first()).toContainText('github__merge_pull_request');
  // A call that had to ask its creator reads "asked you", in amber, not "refused".
  await expect(entries.first().locator('[data-decision]')).toHaveAttribute(
    'data-decision',
    'asked',
  );
  await expect(entries.first()).toContainText('asked you');
  await expect(entries.last()).toContainText('created a mission');
  await expect(page.getByText('kept 90 days')).toBeVisible();

  // Six columns by default; the mission is a seventh, behind "Show details", remembered.
  await expect(record.getByRole('columnheader')).toHaveText([
    'Time',
    'Who',
    'Action',
    'On',
    'Permission',
    'Decision',
  ]);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(record.getByRole('columnheader', { name: 'Mission', exact: true })).toBeVisible();
  await page.reload();
  await expect(record.getByRole('columnheader', { name: 'Mission', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide details' }).click();
  await expect(record.getByRole('columnheader', { name: 'Mission', exact: true })).toBeHidden();

  // Everything else about a line is in its detail, which has an address of its own:
  // what is left of each permission touched, and the fingerprint of the arguments.
  const read = entries.nth(5);
  await expect(read).toContainText('planner');
  await expect(page.getByTestId('entry-detail')).toHaveCount(0);
  await read.getByTestId('entry-detail-link').click();
  await expect(page).toHaveURL(/[?&]open=[^&]+#entry-/);
  const detail = page.getByTestId('entry-detail');
  await expect(detail).toContainText('github.read-code');
  await expect(detail).toContainText('→ 4 left');
  await expect(detail).toContainText('agent label “planner”');
  await expect(detail).toContainText('never stored');
  await expect(detail.getByTestId('arguments-hash')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.locator('body')).not.toContainText(ARGUMENT_MARKER);
  await snap(page, 'audit-mission');
  await read.getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('entry-detail')).toHaveCount(0);

  // The filters: the period as segments and four controls on one line; the others on demand.
  const filters = page.locator('form[action="/activity"]');
  await expect(filters.getByRole('group', { name: 'Period' }).getByRole('link')).toHaveText([
    'Today',
    'Yesterday',
    '7 days',
    'All',
  ]);
  const line = await filters
    .locator('select:visible, input:visible')
    .evaluateAll((controls) =>
      controls.map((control) => Math.round(control.getBoundingClientRect().top)),
    );
  expect(line).toHaveLength(4);
  expect(new Set(line).size).toBe(1);
  await expect(page.getByLabel(/^Who/)).toBeHidden();
  await page.getByRole('button', { name: 'More filters' }).click();
  await expect(page.getByLabel(/^Who/)).toBeVisible();
  // The page does not scroll sideways at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  await page.getByLabel('Decision', { exact: true }).selectOption('refused');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(entries).toHaveCount(2);
  await page.getByLabel('Tool, exact name').fill('github__create_pull_request');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(entries).toHaveCount(1);
  // Refused, in words; the code of the protocol is in the detail of the line.
  await expect(entries.first()).toContainText('refused');
  await expect(entries.first()).toContainText('limit reached');
  await entries.first().getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('entry-detail')).toContainText('budget-exhausted');
  await expect(page.getByTestId('entry-detail')).toContainText('What the agent was told');
  await expect(page.getByLabel('Mission', { exact: true })).toHaveValue(day.mission_id);

  await page.getByLabel('Tool, exact name').fill('');
  await page.getByLabel('Decision', { exact: true }).selectOption('');
  // The calls one agent label declared.
  await page.getByLabel(/^Agent/).fill('planner');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/[?&]agent=planner(&|$)/);
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('planner');
  await expect(entries.first()).toContainText('github__get_file');
  await page.getByLabel(/^Agent/).fill('');
  await page.getByLabel(/^From · /).fill('2020-01-01');
  await page.getByLabel(/^To · /).fill('2020-01-02');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Nothing was recorded for these filters.')).toBeVisible();

  // The page is in the navigation, and "Clear" brings everything back.
  await page.getByRole('link', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity' }),
  ).toBeVisible();
  await expect(entries.first()).toBeVisible();
});

test('the audit table shows every column at 1280 px', async ({ page, request }) => {
  // The argument fingerprint is 64 hex characters with no break opportunity;
  // its cell wraps it (`.hash` in `audit.module.css`) so the last column stays
  // on screen at this width.
  const day = await seedDay(request);
  await signIn(page);
  await page.goto(`/activity?mission=${day.mission_id}`);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  // Every column is on screen: the table does not scroll sideways at this width, with the
  // detail of a line open (the fingerprint is 64 characters) and the seventh column shown.
  await page.locator('tbody tr[data-row]').nth(1).getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('entry-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Show details' }).click();
  const table = await page
    .getByTestId('audit-table')
    .locator('table')
    .evaluate((el) => ({
      content: el.scrollWidth,
      box: (el.parentElement ?? el).clientWidth,
    }));
  expect(table.content).toBeLessThanOrEqual(table.box);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.getByRole('button', { name: 'Hide details' }).click();
});

test('the timeline of a mission shows every column at 1280 px', async ({ page, request }) => {
  // Five columns; the page takes the wide measure and the last cell wraps, so the
  // outcome of every event stays on screen at this width.
  const day = await seedDay(request);
  await signIn(page);
  await page.goto(`/missions/${day.mission_id}/session`);
  const timeline = page.getByTestId('timeline');
  await expect(timeline.locator('tbody tr').first()).toBeVisible();
  const table = await page
    .getByTestId('timeline-table')
    .evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }));
  expect(table.content).toBeLessThanOrEqual(table.box);
  // The Detail cell of the last column ends inside the window.
  const detail = await timeline.getByTestId('event-detail').first().boundingBox();
  expect(detail).not.toBeNull();
  expect((detail?.x ?? 0) + (detail?.width ?? 0)).toBeLessThanOrEqual(1280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});

test('the activity of a mission that is not yours does not exist', async ({ page }) => {
  await signIn(page);
  const response = await page.goto('/missions/no-such-mission/session');
  expect(response?.status()).toBe(404);
});
