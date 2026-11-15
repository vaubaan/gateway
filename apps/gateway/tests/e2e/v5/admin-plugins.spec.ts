/**
 * Administration › Plugins, in a browser, against the ephemeral instance: every plugin
 * the image ships, bundled and enabled, with its version; no notice from the versions
 * feed, since the instance reads none (`VAUBAAN_UPDATES_CHECK=false` in
 * `ephemeral-instance.ts`), and the page says the check is off. A row leads to the
 * plugin's Reference page, which names the same version.
 */
import { expect, test } from '@playwright/test';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';
import { passSecondFactor, routeToInstance, signInAs } from './browser';
import { E2E_OPERATOR } from './instance';

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_OPERATOR);
});

test('Administration › Plugins lists every shipped plugin, bundled and enabled, and says the versions check is off', async ({
  page,
  request,
}) => {
  await page.goto('/auth/login?return_to=/admin/plugins');
  await passSecondFactor(page, request, E2E_OPERATOR.email);
  await page.goto('/admin/plugins');
  await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Plugins' }),
  ).toHaveAttribute('aria-current', 'page');

  // One row per plugin the image ships: its version, bundled, enabled.
  const list = page.getByTestId('plugins');
  await expect(list.getByRole('listitem')).toHaveCount(SHIPPED_PLUGINS.length);
  for (const plugin of SHIPPED_PLUGINS) {
    const row = page.getByTestId(`plugin-${plugin.id}`);
    await expect(row).toContainText(`${plugin.id} · ${plugin.version}`);
    await expect(row.getByTestId('plugin-origin')).toHaveText('bundled with the image');
    await expect(row.getByTestId('plugin-disabled')).toHaveCount(0);
  }
  // Ada's GitHub account is served by the GitHub plugin.
  await expect(page.getByTestId('plugin-github').getByTestId('plugin-accounts')).toHaveText(
    /^\d+ accounts?$/,
  );

  // The instance read no feed: no notice, the check is off, nothing to check now.
  await expect(page.getByTestId('updates-notices')).toHaveCount(0);
  await expect(page.getByTestId('updates-footer')).toContainText('versions check is off');
  await expect(page.getByTestId('updates-check-now')).toHaveCount(0);

  // A row leads to the plugin's Reference page, which names the same version, not pinned.
  const github = SHIPPED_PLUGINS.find((plugin) => plugin.id === 'github');
  await page.getByTestId('plugin-github').getByRole('link', { name: 'GitHub' }).click();
  await expect(page).toHaveURL(/\/reference\/github$/);
  await expect(page.getByTestId('service-version')).toHaveText(`plugin ${github?.version}`);
  await expect(page.getByTestId('plugin-pinned')).toHaveCount(0);
});
