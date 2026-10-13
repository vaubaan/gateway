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

test('a day of calls: session page, then the audit of the mission', async ({ page, request }) => {
  const day = await seedDay(request);
  await signIn(page);

  // ── From the mission to its session ───────────────────────────────────────
  await page.goto(`/missions/${day.mission_id}`);
  await page.getByRole('link', { name: 'Session', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session$`));
  await expect(page.getByRole('heading', { name: /Session/, level: 1 })).toContainText(
    '1 risk exhausted',
  );

  // Counters per risk with what is left, and the gate of each.
  const budget = page.locator('table').nth(0);
  const row = (riskId: string) => budget.locator('tr', { hasText: riskId });
  await expect(row('github.read-code')).toContainText('5'); // quota
  await expect(row('github.read-code').locator('td').nth(2)).toHaveText('2');
  await expect(row('github.read-code').locator('td').nth(3)).toHaveText('3');
  await expect(row('github.create-pr').locator('td').nth(3)).toContainText('0');
  await expect(row('github.create-pr')).toContainText('exhausted');
  await expect(row('github.merge-protected').locator('td').nth(5)).toHaveText('approval');
  await expect(row('github.read-code').locator('td').nth(5)).toHaveText('auto');

  // Counters per period: the current one.
  const periods = page.locator('table').nth(1);
  await expect(periods.locator('tbody tr')).toHaveCount(1);
  await expect(periods).toContainText('current');
  await expect(periods).toContainText('2 / 5');
  await expect(periods).toContainText('2 / 2');

  // Open requests: by link only.
  const requests = page.locator('table').nth(2);
  await expect(requests.locator('tbody tr')).toHaveCount(2);
  await expect(requests.getByRole('link', { name: 'Claim' })).toHaveAttribute(
    'href',
    `/requests/${day.claim_id}`,
  );
  await expect(requests.getByRole('link', { name: 'Approval request' })).toHaveAttribute(
    'href',
    `/requests/${day.approval_id}`,
  );

  // Agent labels seen.
  await expect(page.getByText('Agent labels seen')).toBeVisible();
  await expect(page.locator('dd', { hasText: 'planner' })).toContainText('1 call');
  await expect(page.locator('dd', { hasText: 'planner' })).toContainText('coder');

  // Calls of the current period per agent label: informational, beside the shared budget.
  const activity = page.getByTestId('label-activity');
  await expect(activity).toContainText('this is not a budget');
  const labelRow = (label: string) => activity.locator(`tr[data-label="${label}"]`);
  await expect(activity.locator('tbody tr')).toHaveCount(2);
  await expect(labelRow('coder').locator('td').nth(1)).toHaveText('3'); // allowed
  await expect(labelRow('coder').locator('td').nth(2)).toHaveText('2'); // refused
  await expect(labelRow('planner').locator('td').nth(1)).toHaveText('1');
  await expect(labelRow('planner').locator('td').nth(2)).toHaveText('0');

  // Timeline, newest first: the merge awaiting approval is on top.
  const timeline = page.getByTestId('timeline').locator('table');
  await expect(timeline.locator('tbody tr')).toHaveCount(8); // 6 calls + 2 requests
  await expect(timeline.locator('tbody tr').first()).toContainText('approval-required');
  await expect(timeline.locator('tbody tr').last()).toContainText('github__get_file');
  await expect(timeline.locator('tbody tr').last()).toContainText('github.read-code → 4');
  // The refused call and the request it opened both lead to the request page.
  await expect(timeline.getByRole('link', { name: 'open claim' })).toHaveCount(2);
  await expect(timeline.getByRole('link', { name: 'open claim' }).first()).toHaveAttribute(
    'href',
    `/requests/${day.claim_id}`,
  );
  await expect(page.locator('body')).not.toContainText(ARGUMENT_MARKER);
  await snap(page, 'mission-session');

  // The timeline of one label: its calls only; the budget above does not move.
  await labelRow('planner').getByRole('link', { name: 'in the timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session\\?agent=planner$`));
  await expect(page.getByTestId('timeline-filter')).toContainText('planner');
  await expect(timeline.locator('tbody tr')).toHaveCount(1);
  await expect(timeline.locator('tbody tr').first()).toContainText('github__get_file');
  await expect(timeline.locator('tbody tr').first()).toContainText('planner');
  await expect(row('github.read-code').locator('td').nth(2)).toHaveText('2');
  await expect(labelRow('coder').locator('td').nth(1)).toHaveText('3');
  await snap(page, 'mission-session-one-label');
  await page.getByRole('link', { name: 'Show the whole timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${day.mission_id}/session$`));
  await expect(timeline.locator('tbody tr')).toHaveCount(8);

  // ── The audit of this mission ─────────────────────────────────────────────
  await page.getByRole('link', { name: 'Audit of this mission' }).click();
  await expect(page.getByRole('heading', { name: 'Audit', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/audit\\?mission=${day.mission_id}$`));
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
  await expect(page).toHaveURL(/\/audit$/);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit' }),
  ).toBeVisible();
  await expect(entries.first()).toBeVisible();
});

test('the audit table shows every column at 1280 px', async ({ page, request }) => {
  // The argument fingerprint is 64 hex characters with no break opportunity;
  // its cell wraps it (`.hash` in `audit.module.css`) so the last column stays
  // on screen at this width.
  const day = await seedDay(request);
  await signIn(page);
  await page.goto(`/audit?mission=${day.mission_id}`);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  // Every column is on screen: the table does not scroll sideways at this width.
  const table = await page
    .getByTestId('audit-table')
    .evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }));
  expect(table.content).toBeLessThanOrEqual(table.box);
});

test('the session timeline shows every column at 1280 px', async ({ page, request }) => {
  // Five of the six columns hold values that do not wrap (dates, tool names, risk
  // ids); the card takes the width of the window (`.wide`) and the Detail cell
  // wraps (`.detail`), so the last column stays on screen at this width.
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

test('the session of a mission that is not yours does not exist', async ({ page }) => {
  await signIn(page);
  const response = await page.goto('/missions/no-such-mission/session');
  expect(response?.status()).toBe(404);
});
