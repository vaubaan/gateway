/**
 * Accounts refresh themselves on open (spec §0 "Resource", §4.2 "Accounts"), in a
 * browser against the ephemeral instance. Katherine's GitHub account was last
 * refreshed two hours ago and knows one repository; the mocked GitHub lists two for
 * its token. Opening the account shows what is stored at once, marked
 * "Refreshing…", then the new repository appears — nobody presses "Refresh".
 */
import { expect, test } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_REFRESH_USER, MOCK_GITHUB_REFRESH } from './instance';

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_REFRESH_USER);
});

test('a stale account refreshes itself when its page opens', async ({ page, request }) => {
  const seeded = await request.post(controlUrl('/stale-account'));
  expect(seeded.ok()).toBe(true);
  const { account_id: accountId } = (await seeded.json()) as { account_id: string };

  await page.goto(`/auth/login?return_to=/accounts/${accountId}`);
  const resources = page.getByTestId('account-resources');
  await expect(resources).toContainText(MOCK_GITHUB_REFRESH.known);
  // Rendered with what was stored: two hours old.
  await expect(page.getByTestId('account-updated')).toContainText('Updated 2 h ago');

  // Then, without a click or a reload, the repository GitHub now lists.
  await expect(resources).toContainText(MOCK_GITHUB_REFRESH.appearing);
  await expect(page.getByTestId('account-updated')).toContainText('Updated just now');
  await expect(page.getByTestId('auto-refresh')).toHaveCount(0);
  // The manual refresh stays, small.
  await expect(resources.getByRole('button', { name: 'Refresh' })).toBeVisible();

  // Fresh now: opening it again asks nothing.
  await page.reload();
  await expect(resources).toContainText(MOCK_GITHUB_REFRESH.appearing);
  await expect(page.getByTestId('auto-refresh')).toHaveCount(0);
});
