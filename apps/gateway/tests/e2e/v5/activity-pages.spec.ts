/**
 * Activity past its first 50 lines: pages of 50 in a box of bounded height,
 * reached by Newer and Older; the position is in the address (`cursor`,
 * `after`, `at`), the filters and an open detail survive paging, a filter
 * applies as soon as it is chosen, and without JavaScript the pager is plain
 * links. The Timeline tab pages the same way.
 *
 * Nine days of work for the audit user: at least 63 lines in the record (each
 * day is the creation of a mission and six calls) and 72 session events (six
 * calls and two requests a day).
 */
import { expect, test, type Page } from '@playwright/test';

import { encodeCursor } from '../../../src/server/audit/filters';
import { routeToInstance, seedDay, signInAs } from './browser';
import { E2E_AUDIT_USER } from './instance';

const DAYS = 9;
const PAGE = 50;

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_AUDIT_USER);
});

async function signIn(page: Page, to: string): Promise<void> {
  await page.goto(`/auth/login?return_to=${encodeURIComponent(to)}`);
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
}

/** The id of a line of the record, from the anchor its time cell carries. */
async function lineId(page: Page, index: number): Promise<string> {
  const rows = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  return (await rows.nth(index).locator('[id^="entry-"]').getAttribute('id')) ?? '';
}

test('the record in pages of 50: Older, Newer, Newest, the filters and the open line kept', async ({
  page,
  request,
}) => {
  for (let day = 0; day < DAYS; day += 1) await seedDay(request);
  await signIn(page, '/activity/record');
  const tabs = page.getByRole('navigation', { name: 'Activity' });
  await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Record', 'Timeline']);
  await expect(tabs.getByRole('link', { name: 'Record' })).toHaveAttribute('aria-current', 'page');

  const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  await expect(entries).toHaveCount(PAGE);
  const pager = page.getByTestId('pager');
  await expect(pager.getByTestId('lines-shown')).toHaveText('Lines 1–50');
  // The first page has nothing newer: the word is there, not a link.
  await expect(pager.getByRole('link', { name: 'Newer' })).toHaveCount(0);
  await expect(pager.getByTestId('pager-newer')).toHaveAttribute('aria-disabled', 'true');
  // The lines scroll inside their box; the pager stays in view.
  const box = await page
    .getByTestId('audit-table')
    .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(box.scroll).toBeGreaterThan(box.client);
  const firstOfPageOne = await lineId(page, 0);
  const lastOfPageOne = await lineId(page, PAGE - 1);

  // Older: the next 50, the position in the address; no line twice.
  await pager.getByRole('link', { name: 'Older' }).click();
  await expect(page).toHaveURL(/[?&]cursor=[^&]+/);
  await expect(page).toHaveURL(/[?&]at=51(&|$)/);
  await expect(pager.getByTestId('lines-shown')).toHaveText(/^Lines 51–/);
  await expect(entries.first().locator('[id^="entry-"]')).not.toHaveAttribute('id', firstOfPageOne);
  const pageTwo = await entries
    .locator('[id^="entry-"]')
    .evaluateAll((cells) => cells.map((cell) => cell.id));
  expect(pageTwo).not.toContain(lastOfPageOne);
  expect(new Set(pageTwo).size).toBe(pageTwo.length);

  // A line of this page opens its detail at its own address, and the page stays.
  await entries.nth(2).getByTestId('entry-detail-link').click();
  await expect(page).toHaveURL(/[?&]open=[^&#]+/);
  await expect(page).toHaveURL(/[?&]cursor=[^&]+/);
  await expect(page.getByTestId('entry-detail')).toBeVisible();
  await expect(pager.getByTestId('lines-shown')).toHaveText(/^Lines 51–/);
  await entries.nth(2).getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('entry-detail')).toHaveCount(0);

  // Newer: back to the first page, the same lines; Newest is the plain address.
  await pager.getByRole('link', { name: 'Newer' }).click();
  await expect(page).toHaveURL(/[?&]after=[^&]+/);
  await expect(pager.getByTestId('lines-shown')).toHaveText('Lines 1–50');
  await expect(entries.first().locator('[id^="entry-"]')).toHaveAttribute('id', firstOfPageOne);
  await pager.getByRole('link', { name: 'Older' }).click();
  await pager.getByRole('link', { name: 'Newest' }).click();
  await expect(page).toHaveURL(/\/activity\/record$/);

  // A filter applies as soon as it is chosen, and the pages keep it: calls only.
  await expect(page.locator('form[data-live="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'More filters' }).click();
  await page.getByLabel('Kind').selectOption('call');
  await expect(page).toHaveURL(/[?&]kind=call(&|$)/);
  await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
  await expect(entries).toHaveCount(PAGE);
  await pager.getByRole('link', { name: 'Older' }).click();
  await expect(page).toHaveURL(/\?kind=call&cursor=[^&]+&at=51$/);
  await expect(entries.filter({ hasText: 'created a mission' })).toHaveCount(0);
  await expect(page.getByLabel('Kind')).toHaveValue('call');
});

test('a position typed in the address opens the record there', async ({ page, request }) => {
  await seedDay(request);
  await signIn(page, '/activity/record');
  const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  await expect(entries).toHaveCount(PAGE);

  // The position of the tenth line, as the record's own links write it.
  const tenth = entries.nth(9).locator('time');
  const id = (await lineId(page, 9)).slice('entry-'.length);
  const ts = (await tenth.getAttribute('datetime')) ?? '';
  const eleventh = await lineId(page, 10);

  // An older link (`/activity?cursor=`) still opens it, on the Record.
  await page.goto(`/activity?cursor=${encodeCursor({ ts, id })}`);
  await expect(page).toHaveURL(/\/activity\/record\?cursor=/);
  await expect(entries.first().locator('[id^="entry-"]')).toHaveAttribute('id', eleventh);
  // Without its number, the page says how many lines it shows.
  await expect(page.getByTestId('lines-shown')).toHaveText(`${PAGE} lines`);
  await expect(page.getByRole('link', { name: 'Newest' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Newer' })).toBeVisible();
});

test('the Timeline pages the events of every mission the same way', async ({ page, request }) => {
  for (let day = 0; day < DAYS; day += 1) await seedDay(request);
  await signIn(page, '/activity/timeline');
  const tabs = page.getByRole('navigation', { name: 'Activity' });
  await expect(tabs.getByRole('link', { name: 'Timeline' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const events = page.getByTestId('timeline-table').locator('tbody tr[data-row]');
  await expect(events).toHaveCount(PAGE);
  // Every event says its mission when the missions are mixed.
  await expect(events.first().getByTestId('event-mission')).toBeVisible();
  const pager = page.getByTestId('pager');
  await expect(pager.getByTestId('lines-shown')).toHaveText('Lines 1–50');
  await pager.getByRole('link', { name: 'Older' }).click();
  await expect(page).toHaveURL(/\/activity\/timeline\?cursor=[^&]+&at=51$/);
  await expect.poll(() => events.count()).toBeGreaterThan(0);
  await pager.getByRole('link', { name: 'Newer' }).click();
  await expect(pager.getByTestId('lines-shown')).toHaveText('Lines 1–50');

  // The mission filter applies at once; its events no longer name the mission.
  await expect(page.locator('form[data-live="true"]')).toHaveCount(1);
  const mission = page.getByLabel('Mission', { exact: true });
  const firstMission = await mission.locator('option').nth(1).getAttribute('value');
  await mission.selectOption(firstMission ?? '');
  await expect(page).toHaveURL(new RegExp(`[?&]mission=${firstMission}(&|$)`));
  await expect(events).toHaveCount(8); // six calls and two requests
  await expect(page.getByTestId('event-mission')).toHaveCount(0);
  await expect(page.getByTestId('pager-older')).toHaveAttribute('aria-disabled', 'true');
});

test('without JavaScript, the pager is links and the filters wait for a button', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await routeToInstance(context);
    await signInAs(context.request, E2E_AUDIT_USER);
    const page = await context.newPage();
    await signIn(page, '/activity/record');
    const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
    await expect(entries).toHaveCount(PAGE);
    await page.getByTestId('pager').getByRole('link', { name: 'Older' }).click();
    await expect(page).toHaveURL(/[?&]cursor=[^&]+&at=51/);
    await expect(page.getByTestId('lines-shown')).toHaveText(/^Lines 51–/);
    await page.getByLabel('Decision', { exact: true }).selectOption('refused');
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page).toHaveURL(/[?&]decision=refused/);
    // A new filter starts from the newest lines: the position is not a field of the form.
    await expect(page).not.toHaveURL(/[?&](cursor|after|at)=/);
    await expect(page.getByLabel('Decision', { exact: true })).toHaveValue('refused');
    await expect(entries.first()).toBeVisible();
  } finally {
    await context.close();
  }
});
