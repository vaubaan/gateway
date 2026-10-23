/**
 * The Activity page past its first 50 lines: the next page is loaded as the
 * reader scrolls to the end of the list, appended to the same table, with the
 * filters kept; a line loaded later opens its detail without losing the lines
 * already loaded; `?cursor=` still opens the record at a position; without
 * JavaScript, "Load earlier" is a plain link that does the same.
 *
 * Nine days of work for the audit user: at least 63 lines (each day is the
 * creation of a mission and six calls), 54 of them calls.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

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

/** Scrolls to the end of the list until the record says there is nothing earlier. */
async function scrollToTheEnd(page: Page): Promise<void> {
  const end = page.getByTestId('no-earlier');
  for (let step = 0; step < 10 && !(await end.isVisible()); step += 1) {
    const more = page.getByTestId('load-earlier');
    if (await more.isVisible()) await more.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }
  await expect(end).toBeVisible();
}

async function expectCountMatchesHint(page: Page, entries: Locator): Promise<number> {
  const shown = await entries.count();
  await expect(page.getByTestId('lines-shown')).toHaveText(`${shown} lines`);
  return shown;
}

test('scrolling past 50 lines loads the earlier ones, filters and detail kept', async ({
  page,
  request,
}) => {
  for (let day = 0; day < DAYS; day += 1) await seedDay(request);
  await signIn(page, '/activity');

  const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  // The first page is rendered by the server: 50 lines, and a way to the earlier ones.
  await expect(entries).toHaveCount(PAGE);
  await expect(page.getByTestId('lines-shown')).toHaveText('50 lines');
  await expect(page.getByRole('link', { name: 'Load earlier' })).toBeVisible();
  const firstId = await entries.first().locator('[id^="entry-"]').getAttribute('id');

  // Near the end of the list, the next page is appended under the lines already there.
  await page.getByTestId('load-earlier').scrollIntoViewIfNeeded();
  await expect(page).toHaveURL(/[?&]lines=100(&|$)/);
  await expect.poll(() => entries.count()).toBeGreaterThan(PAGE);
  await expect(entries.first().locator('[id^="entry-"]')).toHaveAttribute('id', firstId ?? '');
  await scrollToTheEnd(page);
  const all = await expectCountMatchesHint(page, entries);
  expect(all).toBeGreaterThanOrEqual(DAYS * 7);
  // Every line once.
  const ids = await entries
    .locator('[id^="entry-"]')
    .evaluateAll((cells) => cells.map((cell) => cell.id));
  expect(new Set(ids).size).toBe(ids.length);

  // A line loaded later opens its detail; the lines loaded stay.
  const late = entries.nth(PAGE + 2);
  await late.getByTestId('entry-detail-link').click();
  await expect(page).toHaveURL(/[?&]open=[^&#]+/);
  await expect(page).toHaveURL(/[?&]lines=\d+/);
  await expect(page.getByTestId('entry-detail')).toBeVisible();
  await expect(entries).toHaveCount(all);
  await late.getByTestId('entry-detail-link').click();
  await expect(page.getByTestId('entry-detail')).toHaveCount(0);
  await expect(entries).toHaveCount(all);

  // The filters are kept from page to page: calls only.
  await page.goto('/activity?kind=call');
  await expect(entries).toHaveCount(PAGE);
  await page.getByTestId('load-earlier').scrollIntoViewIfNeeded();
  await expect(page).toHaveURL(/\?kind=call&lines=100(&|$)/);
  await expect.poll(() => entries.count()).toBeGreaterThan(PAGE);
  await scrollToTheEnd(page);
  await expectCountMatchesHint(page, entries);
  await expect(entries.filter({ hasText: 'created a mission' })).toHaveCount(0);
});

test('a position in the address still opens the record there, and the list grows from it', async ({
  page,
  request,
}) => {
  await seedDay(request);
  await signIn(page, '/activity');
  const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
  await expect(entries).toHaveCount(PAGE);

  // The position of the tenth line, as the record's own links write it.
  const tenth = entries.nth(9).locator('time');
  const id = ((await entries.nth(9).locator('[id^="entry-"]').getAttribute('id')) ?? '').slice(
    'entry-'.length,
  );
  const ts = (await tenth.getAttribute('datetime')) ?? '';
  const eleventh = await entries.nth(10).locator('[id^="entry-"]').getAttribute('id');

  await page.goto(`/activity?cursor=${encodeCursor({ ts, id })}`);
  await expect(entries.first().locator('[id^="entry-"]')).toHaveAttribute('id', eleventh ?? '');
  await expect(page.getByRole('link', { name: 'Newest' })).toBeVisible();
  await scrollToTheEnd(page);
  await expect(page).toHaveURL(/[?&]cursor=[^&]+/);
  await expectCountMatchesHint(page, entries);
});

test('without JavaScript, "Load earlier" is a link to the longer list', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await routeToInstance(context);
    await signInAs(context.request, E2E_AUDIT_USER);
    const page = await context.newPage();
    await signIn(page, '/activity');
    const entries = page.getByTestId('audit-table').locator('tbody tr[data-row]');
    await expect(entries).toHaveCount(PAGE);
    await page.getByRole('link', { name: 'Load earlier' }).click();
    await expect(page).toHaveURL(/[?&]lines=100(&|$)/);
    await expect.poll(() => entries.count()).toBeGreaterThan(PAGE);
    await expectCountMatchesHint(page, entries);
  } finally {
    await context.close();
  }
});
