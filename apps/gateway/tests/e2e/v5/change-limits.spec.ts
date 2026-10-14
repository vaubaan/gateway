/**
 * "Change limits" in a browser (spec §3.2, §4.2 "On a mission"; ADR
 * mission-limits-editable-after-issuance). The executor holds the key of a mission
 * whose read limit is two; it reaches the limit, the creator follows the limit page
 * to the mission's limits editor, raises the limit, confirms the list of what
 * changes, and the agent's next call passes. Lowered again under what was used, the
 * permission stops at once.
 */
import { expect, test, type Page } from '@playwright/test';

import { connectAgent, type Agent, type CallOutcome } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

const RISK = 'github.read-code';
const readFile = (agent: Agent): Promise<CallOutcome> =>
  agent.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });

async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

let agent: Agent | null = null;
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('the creator raises a reached limit from the mission page, then lowers it under what was used', async ({
  browser,
  request,
}) => {
  await signInAs(request, E2E_USER);
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  const issued = await issueSmallMission(request, 'Read the pricing code');
  const executor = (agent = await connectAgent(issued.token));
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });
  const third = await readFile(executor);
  if (third.outcome !== 'refused') throw new Error('the limit never refused');
  expect(third.refusal.code).toBe('budget-exhausted');

  // The limit page leads to the limits of the mission.
  await page.goto('/auth/login?return_to=/missions');
  await page.goto(String(third.refusal.claim_url));
  await page.getByTestId('claim-change-limit').click();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}\?edit=limits#permissions$/);

  // The table of the mission's permissions, in edit mode for its limits only.
  const editor = page.getByTestId('limits-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(RISK);
  await expect(editor).toContainText('2 used today');
  // Nothing else is editable: no tick, no "ask me first" switch.
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await expect(editor.getByRole('switch')).toHaveCount(0);
  const review = page.getByTestId('limits-review');
  await expect(review).toBeDisabled();

  const quota = page.getByTestId(`limit-quota-${RISK}`);
  await quota.fill('0');
  await expect(review).toBeDisabled();
  await expect(page.getByText('Each limit is a whole number of at least 1.')).toBeVisible();
  await quota.fill('5');
  await snap(page, 'change-limits-editor');
  await review.click();

  // The confirmation lists what changes, before and after, and what a change does.
  const confirm = page.getByTestId('limits-confirm');
  await expect(confirm).toContainText('Change the limit of 1 permission?');
  await expect(page.getByTestId('limits-changes')).toContainText('per day: 2 → 5');
  await expect(confirm).toContainText('from the next call');
  await snap(page, 'change-limits-confirm');
  await confirm.getByRole('button', { name: 'Change limits' }).click();

  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}#permissions$/);
  await expect(page.getByTestId('limits-editor')).toHaveCount(0);
  await expect(page.getByTestId('change-limits')).toBeVisible();

  // The agent's next call passes under the new limit; the used calls still count.
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });

  // Lowered under what was used (3): the permission stops at once, and the dialog says so.
  await page.getByTestId('change-limits').click();
  await page.getByTestId(`limit-quota-${RISK}`).fill('3');
  await page.getByTestId('limits-review').click();
  await expect(page.getByTestId('limits-confirm')).toContainText('already used its new limit');
  await page.getByTestId('limits-confirm').getByRole('button', { name: 'Change limits' }).click();
  await expect(page.getByTestId('limits-editor')).toHaveCount(0);
  const refused = await readFile(executor);
  expect(refused).toMatchObject({ outcome: 'refused' });
  if (refused.outcome === 'refused') {
    expect(refused.refusal).toMatchObject({ code: 'budget-exhausted', quota: 3, consumed: 3 });
  }

  // Each change is one line of the activity.
  await page.goto('/activity');
  await expect(page.getByText('changed the limits of a mission').first()).toBeVisible();

  // The claim the agent left is answered, so that nothing of this mission waits.
  await page.goto(String(third.refusal.claim_url));
  await page.getByTestId('answer-refuse').getByRole('radio').check();
  await page.getByRole('button', { name: 'Leave it until the reset' }).click();
  await expect(page.getByTestId('open-request-count')).toHaveCount(0);
  await context.close();
});
