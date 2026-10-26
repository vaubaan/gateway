/**
 * "Edit mission" in a browser (spec §3.2 "Editing a mission", §4.2, §7.4 bis; ADR
 * mission-editable-after-issuance). The executor holds the key of a mission on the
 * three repositories of an account; the creator opens the mission, edits it on the
 * creation screen prefilled with it — a new name, one repository less —, reads the
 * list of changes with what each means, saves, and the agent's next call, with the
 * same key, is refused on the repository that left the mission.
 */
import { expect, test } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

let agent: Agent | null = null;
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('the creator edits a running mission; the same key sees it at its next call', async ({
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
  await page.getByTestId('edit-mission').click();
  await expect(page).toHaveURL(new RegExp(`/missions/${issued.mission_id}/edit$`));

  // The creation screen, prefilled with the mission; the period is fixed.
  const name = page.getByLabel('Mission name');
  await expect(name).toHaveValue('Read the billing code');
  await expect(page.locator('#mission-period')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  await name.fill('Read the billing code, web only');
  await page.getByRole('button', { name: /^Change the resources of GitHub/ }).click();
  await page.getByRole('checkbox', { name: 'Resource acme/app' }).uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();

  // Every change, before and after, with what it means.
  const confirm = page.getByTestId('confirm-edit');
  const changes = page.getByTestId('edit-changes');
  await expect(changes).toContainText(
    '“Read the billing code” → “Read the billing code, web only”',
  );
  await expect(changes).toContainText('acme/app removed');
  await expect(changes).toContainText('No longer reached');
  await confirm.getByRole('button', { name: 'Save changes' }).click();

  await expect(page).toHaveURL(new RegExp(`/missions/${issued.mission_id}\\?edited=1$`));
  await expect(page.getByTestId('mission-edited')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Read the billing code, web only' }),
  ).toBeVisible();

  // Same key: the repository that left the mission is refused from the next call.
  const refused = await readApp();
  expect(refused).toMatchObject({ outcome: 'refused' });
  if (refused.outcome === 'refused') expect(refused.refusal.code).toBe('resource-not-in-mission');

  // The mission's activity says the change in words.
  await page.goto(`/missions/${issued.mission_id}/session`);
  await expect(page.getByText('changed the mission').first()).toBeVisible();
  await context.close();
});
