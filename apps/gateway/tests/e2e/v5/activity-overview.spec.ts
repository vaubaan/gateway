/**
 * The Overview of Activity (`/activity`, spec §4.2 "Activity"): one block per
 * mission with its calls, waiting requests and bytes; its accounts, use per
 * action and key holders behind a disclosure; a period chosen by links; and
 * every number opening the Record or the Timeline filtered on it.
 *
 * A day of work for the audit user (`seedDayOfWork`): two reads and two pull
 * requests allowed, a third pull request and a protected merge refused, each
 * opening a request that waits.
 */
import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, seedDay, signInAs } from './browser';
import { E2E_AUDIT_USER } from './instance';

async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_AUDIT_USER);
});

async function signIn(page: Page, to: string): Promise<void> {
  await page.goto(`/auth/login?return_to=${encodeURIComponent(to)}`);
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
}

test('the Overview sums a mission and every number opens the lines it counts', async ({
  page,
  request,
}) => {
  const day = await seedDay(request);
  await signIn(page, '/activity');
  await expect(page).toHaveURL(/\/activity$/);
  const tabs = page.getByRole('navigation', { name: 'Activity' });
  await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Record', 'Timeline']);
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const block = page.getByTestId(`overview-mission-${day.mission_id}`);
  await expect(block.getByRole('heading', { name: 'A day of work' })).toBeVisible();
  await expect(block.getByTestId('figure-allowed')).toHaveText('4');
  await expect(block.getByTestId('figure-refused')).toHaveText('2');
  await expect(block.getByTestId('figure-waiting')).toHaveText('2');
  // Bytes in human units: four allowed calls each received 2,048 bytes.
  await expect(block.getByTestId('figure-down')).toHaveText('8.2 KB');
  await expect(block.getByTestId('figure-up')).toHaveText(/^\d+ B$/);
  await snap(page, 'activity-overview');

  // Behind the disclosure: the account, the use per action, who holds the keys.
  await block.getByRole('button', { name: 'Accounts, permissions and keys' }).click();
  const accounts = block.getByTestId(`overview-accounts-${day.mission_id}`);
  await expect(accounts.getByRole('listitem')).toHaveCount(1);
  await expect(accounts).toContainText('6 calls');
  const actions = block.getByTestId(`overview-actions-${day.mission_id}`);
  await expect(actions.getByRole('meter').first()).toBeVisible();
  const holders = block.getByTestId(`overview-holders-${day.mission_id}`);
  await expect(holders).toContainText(E2E_AUDIT_USER.email);
  await expect(holders).toContainText('100%');
  await snap(page, 'activity-overview-open');

  // "2 refused" opens those two lines of the Record.
  await block.getByTestId('figure-refused').click();
  await expect(page).toHaveURL(/\/activity\/record\?/);
  await expect(page).toHaveURL(new RegExp(`[?&]mission=${day.mission_id}(&|$)`));
  await expect(page).toHaveURL(/[?&]decision=refused(&|$)/);
  await expect(page.getByTestId('audit-table').locator('tbody tr[data-row]')).toHaveCount(2);

  // The mission's timeline, from its block.
  await page.goBack();
  await page.getByTestId(`overview-timeline-${day.mission_id}`).click();
  await expect(page).toHaveURL(new RegExp(`/activity/timeline\\?mission=${day.mission_id}$`));
  await expect(page.getByTestId('timeline-table').locator('tbody tr').first()).toBeVisible();
});

test('the period is a link, and an older address of the Record still opens the Record', async ({
  page,
  request,
}) => {
  const day = await seedDay(request);
  await signIn(page, '/activity');
  const period = page.getByRole('group', { name: 'Period' });
  await expect(period.getByRole('link', { name: '7 days' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await period.getByRole('link', { name: '30 days' }).click();
  await expect(page).toHaveURL(/\/activity\?period=30d$/);
  await expect(period.getByRole('link', { name: '30 days' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(
    page.getByTestId(`overview-mission-${day.mission_id}`).getByTestId('figure-allowed'),
  ).toHaveText('4');

  await page.goto(`/activity?mission=${day.mission_id}`);
  await expect(page).toHaveURL(new RegExp(`/activity/record\\?mission=${day.mission_id}$`));
});
