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
  const entries = page.locator('table tbody tr');
  // Six calls and the issuance of the mission.
  await expect(entries).toHaveCount(7);
  await expect(page.getByLabel('Mission')).toHaveValue(day.mission_id);
  await expect(entries.first()).toContainText('github__merge_pull_request');
  await expect(entries.first()).toContainText('approval-required');
  await expect(entries.last()).toContainText('mission-issued');
  // The remaining budget of each call, and the hash of its arguments.
  await expect(entries.nth(5)).toContainText('github.read-code → 4');
  await expect(entries.nth(5).getByTestId('arguments-hash')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(entries.nth(5)).toContainText('agent planner');
  await expect(page.locator('body')).not.toContainText(ARGUMENT_MARKER);
  await snap(page, 'audit-mission');

  // Ten filters in three named groups — what, who, when — on two rows; refused calls of one tool.
  const filters = page.locator('form');
  await expect(filters.getByRole('group', { name: 'What' }).locator('label')).toHaveCount(5);
  await expect(filters.getByRole('group', { name: 'Who' }).locator('label')).toHaveCount(3);
  await expect(filters.getByRole('group', { name: 'When' }).locator('label')).toHaveCount(2);
  const boxes = await filters
    .locator('label')
    .evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
  expect(boxes).toHaveLength(10);
  expect(new Set(boxes).size).toBe(2);
  // A tool name and a risk id wrap between their words, never inside one.
  const breaks = await page
    .getByTestId('audit-table')
    .locator('[data-kind="tool"], [data-kind="risk"]')
    .evaluateAll((slugs) =>
      slugs.every((slug) => {
        const text = slug.querySelector('span');
        if (!text) return false;
        // Each word is one text node: a word broken across two lines has two boxes.
        return [...text.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .every((word) => {
            const range = document.createRange();
            range.selectNodeContents(word);
            return range.getClientRects().length === 1;
          });
      }),
    );
  expect(breaks).toBe(true);
  // And the table shows its last column without scrolling the page sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  await page.getByLabel('Decision').selectOption('refused');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(entries).toHaveCount(2);
  await page.getByLabel('Tool').fill('github__create_pull_request');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('budget-exhausted');
  await expect(page.getByLabel('Mission')).toHaveValue(day.mission_id);

  await page.getByLabel('Tool').fill('');
  await page.getByLabel('Decision').selectOption('');
  // The calls one agent label declared.
  await page.getByLabel('Agent label').fill('planner');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/[?&]agent=planner(&|$)/);
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('agent planner');
  await expect(entries.first()).toContainText('github__get_file');
  await page.getByLabel('Agent label').fill('');
  await page.getByLabel('From (UTC)').fill('2020-01-01');
  await page.getByLabel('To (UTC)').fill('2020-01-02');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No entry matches.')).toBeVisible();

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
  // Every column is on screen: the table does not scroll sideways at this width.
  const table = await page
    .getByTestId('audit-table')
    .evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }));
  expect(table.content).toBeLessThanOrEqual(table.box);
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
