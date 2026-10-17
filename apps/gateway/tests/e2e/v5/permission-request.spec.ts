import { expect, test } from '@playwright/test';
import { connectAgent, type Agent } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

let agent: Agent | null = null;
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('the creator adds a requested permission, then removes it directly, with the same agent key', async ({
  browser,
  request,
}) => {
  await signInAs(request, E2E_USER);
  const issued = await issueSmallMission(request, 'Write a forgotten file');
  const executor = (agent = await connectAgent(issued.token));
  const args = {
    owner: 'acme',
    repo: 'app',
    branch: 'feature/change',
    path: 'example.txt',
    message: 'Add example',
    content: 'example',
  };
  const refused = await executor.call('github__create_or_update_file', args);
  if (refused.outcome !== 'refused') throw new Error('expected missing permission');
  expect(refused.refusal.code).toBe('risk-not-accepted');
  const asked = await executor.call('vaubaan__request_permission', {
    refusal_id: refused.refusal.refusal_id,
    reason: 'The assigned task needs a new example file.',
  });
  if (asked.outcome !== 'allowed') throw new Error('request refused');
  const response = JSON.parse(asked.text) as { request_url: string };
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  await page.goto('/auth/login?return_to=/missions');
  await page.goto(response.request_url);
  await expect(page.getByRole('heading', { name: 'The agent says' })).toBeVisible();
  await expect(page.getByText('The assigned task needs a new example file.')).toBeVisible();
  const risk = 'github.feature-branch-write';
  await page.getByRole('checkbox', { name: `Include ${risk}`, exact: true }).check();
  await page.getByLabel(`Quota for ${risk}`, { exact: true }).fill('3');
  await page.getByRole('checkbox', { name: `Ask first for ${risk}`, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Review permissions', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('all people and keys');
  await page.getByRole('button', { name: 'Add permissions and answer', exact: true }).click();
  await expect(page.getByTestId('request-decided')).toBeVisible();
  expect(await executor.call('github__create_or_update_file', args)).toMatchObject({
    outcome: 'allowed',
  });
  await page.goto(`/missions/${issued.mission_id}`);
  await page.getByRole('link', { name: 'Modify permissions', exact: true }).click();
  await page.getByRole('checkbox', { name: `Include ${risk}`, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Review permissions', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(`Remove ${risk}`);
  await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${issued.mission_id}#permissions$`));
  expect(await executor.call('github__create_or_update_file', args)).toMatchObject({
    outcome: 'refused',
    refusal: { code: 'risk-not-accepted' },
  });
  await context.close();
});
