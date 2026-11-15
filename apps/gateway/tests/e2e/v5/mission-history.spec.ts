/**
 * A mission's History and its rollback in a browser (spec §4.2 "History"). The creator
 * edits a running mission twice; its page lists three versions, newest first, each with
 * who and why, and what changed one click away. "Restore this version" on the first
 * brings it back at once, without a dialog: the section says "Restored", version 4 heads
 * the list, restored from version 1, and the mission bears its first name again — with
 * the same key, which the agent keeps using.
 */
import { expect, test, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

let agent: Agent | null = null;
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

/** "Edit mission" → a new name → "Save changes", back on the mission page. */
async function rename(page: Page, missionId: string, name: string): Promise<void> {
  await page.getByTestId('edit-mission').click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/edit$`));
  await page.getByLabel('Mission name').fill(name);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}\\?edited=1$`));
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('the creator edits twice, reads three versions and restores the first as the fourth', async ({
  browser,
  request,
}) => {
  await signInAs(request, E2E_USER);
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  const issued = await issueSmallMission(request, 'Read the billing code');
  const executor = (agent = await connectAgent(issued.token));
  const readApp = () =>
    executor.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });
  expect(await readApp()).toMatchObject({ outcome: 'allowed' });

  await page.goto(`/auth/login?return_to=/missions/${issued.mission_id}`);
  await expect(page).toHaveURL(new RegExp(`/missions/${issued.mission_id}$`));
  await rename(page, issued.mission_id, 'Read the billing code, first edit');
  await rename(page, issued.mission_id, 'Read the billing code, second edit');

  // Three versions, newest first: two edits, then the issuance.
  const history = page.getByTestId('mission-history');
  await expect(history.locator('li[data-testid^="mission-version-"]')).toHaveCount(3);
  const v3 = page.getByTestId('mission-version-3');
  await expect(v3).toContainText('Version 3 · Edited');
  await expect(v3).toContainText('Current');
  await expect(page.getByTestId('mission-version-2')).toContainText('Version 2 · Edited');
  await expect(page.getByTestId('mission-version-1')).toContainText('Version 1 · Created');
  // What changed, one click away.
  await v3.getByRole('button', { name: 'What changed' }).click();
  await expect(v3).toContainText(
    'Renamed from “Read the billing code, first edit” to “Read the billing code, second edit”',
  );

  // Restored at once, no dialog: the callout, then version 4 restored from version 1.
  await page.getByTestId('restore-version-1').click();
  await expect(page.getByTestId('mission-restored')).toBeVisible();
  await expect(page.getByTestId('mission-restored')).toContainText(
    'Version 1 is the configuration again, as version 4.',
  );
  const v4 = page.getByTestId('mission-version-4');
  await expect(v4).toContainText('Version 4 · Restored from version 1');
  await expect(v4).toContainText('Current');
  await expect(history.locator('li[data-testid^="mission-version-"]')).toHaveCount(4);
  await expect(
    page.getByRole('heading', { name: 'Read the billing code', exact: true }),
  ).toBeVisible();

  // Same key, still working: a rollback replaces no key.
  expect(await readApp()).toMatchObject({ outcome: 'allowed' });
  await context.close();
});
