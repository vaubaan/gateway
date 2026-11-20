/**
 * "Exhaust and claim" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.6, §3.4, §4.2 "Request inbox" definition
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
  await bob.goto('/waiting');
  await expect(bob.getByTestId('waiting-empty')).toContainText('Nothing waits for you.');
  await expect(bob.getByTestId('open-request-count')).toHaveCount(0);
  await bob.goto(claimUrl.replace('/r/', '/waiting/'));
  await expect(bob.getByText('This request is addressed to its creator.')).toBeVisible();
  expect(await bob.content()).not.toContain(mission);
  await bob.context().close();

  // ── The creator opens it, not signed in yet ─────────────────────────────
  await signInAs(request, E2E_USER);
  const ada = await freshPage(browser);
  await ada.goto(claimUrl);
  // Sign-in on the way, then straight to the request.
  await expect(ada).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);
  await expect(ada.getByRole('heading', { name: 'Waiting for you', level: 1 })).toBeVisible();
  await expect(ada.getByTestId('user-menu')).toContainText(E2E_USER.email);

  // Who was stopped and on which mission, the permission, how much of its limit was used.
  const statement = ada.getByTestId('request-statement');
  await expect(statement).toContainText(`on ${mission} reached a limit`);
  await expect(ada.getByTestId('claim-budget')).toContainText('2 of 2');
  await expect(ada.getByText(RISK).first()).toBeVisible();
  // What led here: the call that was stopped, and the request it left.
  const led = ada.getByTestId('request-events');
  await expect(led).toContainText('was stopped on');
  await expect(led).toContainText('github__get_file_contents');
  await expect(led).toContainText('budget-exhausted');
  await expect(led).toContainText('Asked you for more room after a limit was reached');
  // The other permissions of the mission are one click away.
  await ada
    .getByRole('button', { name: /^Show the .* other permissions? of the mission$/ })
    .click();
  await expect(ada.getByRole('row', { name: /github\.read-meta/ })).toContainText('10');

  // The ways of answering, each with what it does; the one that does not apply is not offered.
  await expect(ada.getByTestId('answer-reset-period')).toContainText(
    'the other permissions keep their count',
  );
  await expect(ada.getByTestId('answer-extend-quota')).toContainText('at most 2, what was used');
  await expect(ada.getByTestId('answer-refuse')).toContainText(
    'everything else it may do keeps working',
  );
  // The mission has no end date: there is nothing to extend.
  await expect(ada.getByTestId('answer-extend-expiry')).toHaveCount(0);
  await ada.getByTestId('answer-extend-quota').getByRole('radio').check();
  await expect(ada.getByLabel('Calls to give back')).toHaveValue('2');
  await expect(ada.getByRole('button', { name: 'Give back 2 calls' })).toBeVisible();
  await ada.getByTestId('answer-reset-period').getByRole('radio').check();
  // A limit is changed for good on the mission: the page leads to its limits editor.
  await expect(ada.getByRole('main')).not.toContainText('duplicate the mission');
  await expect(ada.getByTestId('claim-change-limit')).toHaveText('change the limit');
  await expect(ada.getByTestId('claim-change-limit')).toHaveAttribute(
    'href',
    /^\/missions\/[0-9a-f-]{36}\?edit=limits#permissions$/,
  );
  await snap(ada, 'claim-creator-view');

  // The home shows it without any forwarded URL, answerable from there.
  await expect(ada.getByTestId('open-request-count')).toHaveText('1');
  await ada.goto('/');
  await expect(ada.getByRole('heading', { name: 'Now', level: 1 })).toBeVisible();
  const waiting = ada.getByTestId('now-waiting');
  await expect(waiting).toContainText(`${mission} reached its`);
  await snap(ada, 'claim-on-now');
  await waiting.getByRole('link', { name: 'Answer' }).click();
  await expect(ada).toHaveURL(/\/waiting\/[0-9a-f-]{36}$/);

  // So does the inbox: one list, the request open beside it.
  await ada
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Waiting for you/ })
    .click();
  await expect(ada).toHaveURL(/\/waiting$/);
  const item = ada.getByTestId('waiting-list').getByRole('link', { name: new RegExp(mission) });
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(ada.getByTestId('request-statement')).toContainText(mission);
  await snap(ada, 'request-inbox');

  // Still exhausted until the creator decides.
  expect(await readFile(executor)).toMatchObject({
    outcome: 'refused',
    refusal: { code: 'budget-exhausted' },
  });

  // ── The decision ────────────────────────────────────────────────────────
  await ada.getByRole('button', { name: 'Reset the count' }).click();
  await expect(ada).toHaveURL(/\/waiting\/[0-9a-f-]{36}\?decided=1$/);
  await expect(ada.getByTestId('request-decided')).toBeVisible();
  await expect(ada.getByTestId('request-state')).toHaveText('answered');
  await expect(ada.getByTestId('claim-outcome')).toContainText('You reset the count');
  await expect(ada.getByTestId('limit-answer')).toHaveCount(0);
  await expect(ada.getByTestId('request-events')).toContainText(
    'You reset the count of this permission',
  );
  await expect(ada.getByTestId('claim-budget')).toContainText('0 of 2');
  await expect(ada.getByTestId('open-request-count')).toHaveCount(0);
  await snap(ada, 'claim-granted');

  // The token did not change: the executor replays its call.
  expect(await readFile(executor)).toMatchObject({ outcome: 'allowed' });

  // Nothing waits any more: the inbox and the home each say so in one sentence.
  await ada.goto('/waiting');
  await expect(ada.getByTestId('waiting-empty')).toContainText('Nothing waits for you.');
  await expect(ada.getByTestId('waiting-empty')).toContainText('1 approved');
  await ada.goto('/');
  await expect(ada.getByTestId('now-nothing')).toContainText('Nothing needs you.');
  await snap(ada, 'now-nothing-needs-you');
  await ada.context().close();
});
