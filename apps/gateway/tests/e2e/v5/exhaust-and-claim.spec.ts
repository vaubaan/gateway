/**
 * "Exhaust and claim" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.6, §3.4, §4.2 "Request inbox"; plan P1.7 definition
 * of done).
 *
 * The executor is an MCP client holding the mission token: its calls go over
 * HTTP on `/mcp`, through the execution door, to the mocked GitHub. Two pass,
 * the third is refused `budget-exhausted` with the claim URL. The URL is then
 * opened by someone else (403, no detail) and by the creator, who signs in on
 * the way, reads the session and decides; the executor replays its call with
 * the same token.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent, type CallOutcome } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_OTHER_USER, E2E_USER, PUBLIC_URL } from './instance';

const RISK = 'github.read-code';
/** One read of `github.read-code`; the mission's quota is two. */
const readFile = (agent: Agent): Promise<CallOutcome> =>
  agent.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await routeToInstance(context);
  return context.newPage();
}

let agent: Agent | null = null;

test.beforeEach(async ({ request }) => {
  // The scenario changes hands twice; it starts with nobody in particular.
  await signInAs(request, E2E_OTHER_USER);
});
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('exhaust a budget, then the creator — and only the creator — answers the claim', async ({
  browser,
  request,
}) => {
  const mission = 'Read the billing code';
  const issued = await issueSmallMission(request, mission);
  const executor = (agent = await connectAgent(issued.token));
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });
  const third = await readFile(executor);
  if (third.outcome !== 'refused') throw new Error('the budget never refused');
  expect(third.refusal.code).toBe('budget-exhausted');
  const claimUrl = String(third.refusal.claim_url);
  expect(claimUrl).toMatch(new RegExp(`^${PUBLIC_URL}/r/[0-9a-f-]{36}$`));
  expect(third.refusal.hint).toContain(claimUrl);

  // ── Someone else opens the forwarded URL ────────────────────────────────
  await signInAs(request, E2E_OTHER_USER);
  const bob = await freshPage(browser);
  await bob.goto('/auth/login?return_to=/missions');
  await expect(bob.getByText(E2E_OTHER_USER.email)).toBeVisible();
  const refused = await bob.goto(claimUrl);
  expect(refused?.status()).toBe(403);
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  const refusedHtml = await bob.content();
  for (const detail of [mission, RISK, E2E_USER.email]) expect(refusedHtml).not.toContain(detail);
  // Nor is it in their inbox, nor reachable by its inbox address.
  await bob.goto('/requests');
  await expect(bob.getByText('Nothing awaits you.')).toBeVisible();
  await expect(bob.getByTestId('open-request-count')).toHaveCount(0);
  await bob.goto(claimUrl.replace('/r/', '/requests/'));
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  expect(await bob.content()).not.toContain(mission);
  await bob.context().close();

  // ── The creator opens it, not signed in yet ─────────────────────────────
  await signInAs(request, E2E_USER);
  const ada = await freshPage(browser);
  await ada.goto(claimUrl);
  // Sign-in on the way, then straight to the request.
  await expect(ada).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(ada.getByRole('heading', { name: `Claim on ${mission}` })).toBeVisible();
  await expect(ada.getByText(E2E_USER.email)).toBeVisible();

  // The risk concerned, its budget, the other risks, the session.
  await expect(ada.getByTestId('claim-budget')).toHaveText('quota 2 · consumed 2 · 0 left');
  await expect(ada.getByText(RISK).first()).toBeVisible();
  await expect(ada.getByRole('row', { name: /github\.read-meta/ })).toContainText('10');
  await expect(
    ada.getByRole('row', { name: /Refused github__get_file_contents \(budget-exhausted\)/ }),
  ).toBeVisible();
  await expect(ada.getByRole('row', { name: /A claim was dropped/ })).toBeVisible();

  // Four actions, each with its consequence in one line.
  await expect(ada.getByTestId('action-reset-period')).toContainText(
    'Every counter of this mission goes back to zero',
  );
  await expect(ada.getByTestId('action-extend-quota')).toContainText('for the current period only');
  await expect(ada.getByLabel('Actions to give back')).toHaveValue('2');
  await expect(ada.getByTestId('action-extend-expiry')).toContainText('The mission never expires');
  await expect(ada.getByRole('button', { name: 'Extend the expiry' })).toBeDisabled();
  await expect(ada.getByTestId('action-refuse')).toContainText('stays exhausted');
  await snap(ada, 'claim-creator-view');

  // The inbox shows it without any forwarded URL.
  await expect(ada.getByTestId('open-request-count')).toHaveText('1');
  await ada
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Requests/ })
    .click();
  await expect(ada.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
  const row = ada.getByRole('row', { name: new RegExp(mission) });
  await expect(row).toContainText(RISK);
  await snap(ada, 'request-inbox');
  await row.getByRole('link', { name: 'Claim' }).click();
  await expect(ada.getByRole('heading', { name: `Claim on ${mission}` })).toBeVisible();

  // Still exhausted until the creator decides.
  expect(await readFile(executor)).toMatchObject({
    outcome: 'refused',
    refusal: { code: 'budget-exhausted' },
  });

  // ── The decision ────────────────────────────────────────────────────────
  await ada.getByRole('button', { name: 'Reset the period' }).click();
  await expect(ada.getByText('Decision recorded')).toBeVisible();
  await expect(ada.getByText('granted', { exact: true })).toBeVisible();
  await expect(ada.getByRole('button', { name: 'Reset the period' })).toHaveCount(0);
  await expect(ada.getByRole('row', { name: /The creator reset the period/ })).toBeVisible();
  await expect(ada.getByTestId('claim-budget')).toHaveText('quota 2 · consumed 0 · 2 left');
  await expect(ada.getByTestId('open-request-count')).toHaveCount(0);
  await snap(ada, 'claim-granted');

  // The token did not change: the executor replays its call.
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });

  await ada.goto('/requests');
  await expect(ada.getByText('Nothing awaits you.')).toBeVisible();
  await ada.context().close();
});
