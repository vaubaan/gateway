/**
 * "Issue a mission" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.4, §4.2, §4.4; plan P1.5 definition of done).
 *
 * The signed-in user owns a GitHub, a Supabase and a Vercel connection (and
 * an experimental Gmail one). The first test issues a three-connection
 * mission and checks the screen is the one-page flow the spec asks for, then
 * follows the token through rotation and revocation; the second covers the
 * two other ways to start: an agent's proposal and a duplicate.
 */
import { expect, test, type Page } from '@playwright/test';

import { checkToken, routeToInstance } from './browser';
import { E2E_USER } from './instance';

const TOKEN = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context }) => {
  await routeToInstance(context);
});

/** `/missions` behind the IdP: the round trip through the simulated consent screen. */
async function signIn(page: Page): Promise<void> {
  // No session: the page sends the visitor to the sign-in.
  await page.goto('/missions');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/auth/login?return_to=/missions');
  await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible();
  await expect(page.getByText(E2E_USER.email)).toBeVisible();
}

async function includeWithPreset(page: Page, connection: string, preset: string): Promise<void> {
  await page.getByLabel(`Include ${connection}`).check();
  await page.getByLabel(`Preset for ${connection}`).selectOption({ label: preset });
}

async function revealedToken(page: Page): Promise<string> {
  const env = await page.getByRole('dialog').getByTestId('kit-env').innerText();
  const match = TOKEN.exec(env);
  if (!match) throw new Error(`no token in the env snippet: ${env}`);
  return match[0];
}

test('issue a three-connection mission on one page, then rotate and revoke', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'New mission' }).first().click();
  await expect(page.getByRole('heading', { name: 'New mission' })).toBeVisible();

  // Experimental plugins stay out of issuance until the creator asks for them.
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);
  await page.getByLabel('Show experimental providers').check();
  await expect(page.getByTestId('connection-gmail')).toBeVisible();
  await page.getByLabel('Show experimental providers').uncheck();
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);

  // Nothing is issuable before a name, a connection and a preset.
  const issue = page.getByRole('button', { name: 'Issue mission' });
  await expect(issue).toBeDisabled();

  await page.getByLabel('Mission name').fill('Ship the billing page');
  await includeWithPreset(page, 'GitHub acme-org', 'Developer');
  await includeWithPreset(page, 'Supabase Acme Supabase', 'Staging developer');
  await includeWithPreset(page, 'Vercel Acme Vercel', 'Developer');

  // Resources: all selected by default, folded behind one link per connection.
  await expect(page.getByRole('button', { name: '3 of 3 resources' })).toBeVisible();
  await expect(page.getByLabel('Resource acme/app')).toHaveCount(0);

  // The three-line summary says it all.
  await expect(page.getByTestId('summary-can')).toContainText('GitHub "acme-org"');
  await expect(page.getByTestId('summary-can')).toContainText('Supabase "Acme Supabase"');
  await expect(page.getByTestId('summary-can')).toContainText('Vercel "Acme Vercel"');
  await expect(page.getByTestId('summary-can')).toContainText('on 3 of 3 resources');
  await expect(page.getByTestId('summary-cannot')).toContainText('withheld');
  await expect(page.getByTestId('summary-quantities')).toContainText('per day');
  await expect(page.getByTestId('summary-quantities')).toContainText('never expires');
  await expect(issue).toBeEnabled();

  // One page: with three connections filled in, the per-risk detail is folded,
  // no wall of checkboxes, and the whole form is at most one scroll away.
  await expect(page.locator('details[open]')).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].filter((el) =>
      el.checkVisibility(),
    ).length,
  }));
  await snap(page, 'creation-three-connections');
  expect(layout.pageHeight).toBeLessThanOrEqual(2 * layout.viewport);
  expect(layout.checkboxes).toBeLessThanOrEqual(6);
  await expect(issue).toBeInViewport();

  // Deselecting the staging project drops the staging-only entries of the preset, and says so.
  await page.getByRole('button', { name: '2 of 2 resources' }).first().click();
  await page.getByLabel('Resource stgprojectref').uncheck();
  await expect(page.getByTestId('connection-supabase')).toContainText('left out');
  await expect(page.getByTestId('connection-supabase')).toContainText('labelled "staging"');
  await page.getByLabel('Resource stgprojectref').check();
  await expect(page.getByTestId('connection-supabase')).not.toContainText('left out');

  // Unfold the detail only to adjust: one quota, one gate.
  await page.getByTestId('risks-github').locator(':scope > summary').click();
  await page.getByLabel('Quota for github.read-code').fill('42');
  await page.getByLabel('Gate for github.create-pr').selectOption('approval');
  await expect(page.getByTestId('summary-quantities')).toContainText(
    '3 risks need your approval for each action',
  );
  // Env-qualified entries no selected resource carries are shown and cannot be ticked.
  await page.getByTestId('risks-supabase').locator(':scope > summary').click();
  await expect(page.getByTestId('risks-supabase')).toContainText('unavailable with this selection');
  await expect(page.getByLabel('Accept risk supabase[preview].bulk-row-write')).toHaveCount(0);

  await snap(page, 'creation-detail-unfolded');

  await page.getByLabel('Period').selectOption({ label: 'Quotas reload every week' });
  await page.getByLabel('Expiry').selectOption({ label: 'Expires in 30 days' });
  await expect(page.getByTestId('summary-quantities')).toContainText('per week');

  await issue.click();

  // Reveal once, with the bootstrap kit.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Mission “Ship the billing page” issued');
  const token = await revealedToken(page);
  await expect(page.getByTestId('kit-mcp')).toContainText('"url": "https://gateway.e2e.test/mcp"');
  await expect(page.getByTestId('kit-mcp')).toContainText('Bearer ${VAUBAAN_MISSION_TOKEN}');
  await expect(page.getByTestId('kit-mcp')).not.toContainText(token);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).toContainText('`github.read-code`');
  await expect(page.getByTestId('kit-instructions')).toContainText('hand `claim_url` to the human');
  await expect(page.getByTestId('kit-instructions')).toContainText('Never work around a refusal');
  await expect(page.getByTestId('kit-verify')).toContainText('"method":"tools/list"');
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'verified' });
  await snap(page, 'reveal-once-dialog');

  // The revisited page shows the prefix, never the secret.
  await page.getByRole('button', { name: 'I copied the token' }).click();
  await expect(page.getByRole('heading', { name: /Ship the billing page/ })).toBeVisible();
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  const prefix = token.split('_')[2] ?? '';
  await expect(page.getByText(`vbn_live_${prefix}_…`).first()).toBeVisible();
  expect(await page.content()).not.toContain(token);
  const readCode = page.getByRole('row', { name: /github\.read-code/ });
  await expect(readCode).toContainText('42');
  await expect(page.getByRole('row', { name: /github\.create-pr/ })).toContainText('approval');

  await snap(page, 'mission-detail');

  // Rotate: a new secret, shown once; the old token is refused.
  await page.getByRole('button', { name: 'Rotate token' }).click();
  await expect(page.getByRole('dialog')).toContainText('New token for');
  const rotated = await revealedToken(page);
  expect(rotated).not.toBe(token);
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'retired', reason: 'rotated' });
  expect(await checkToken(request, rotated)).toMatchObject({ outcome: 'verified' });
  await page.getByRole('button', { name: 'I copied the token' }).click();

  // Revoke: the mission refuses everything from now on.
  await page.getByRole('button', { name: 'Revoke mission' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Ship the billing page');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('revoked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate token' })).toHaveCount(0);
  expect(await checkToken(request, rotated)).toMatchObject({
    outcome: 'retired',
    reason: 'revoked',
    mission_status: 'revoked',
  });

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Missions' })
    .click();
  await expect(page.getByRole('row', { name: /Ship the billing page/ })).toContainText('revoked');
});

test('start from an agent’s proposal, then duplicate the mission', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/missions/new');

  await page.getByRole('button', { name: 'Paste an agent’s proposal' }).click();
  await page.getByLabel('Agent proposal (JSON)').fill(
    JSON.stringify({
      name: 'Review the pricing PR',
      connections: [
        {
          provider: 'github',
          preset: 'read-only',
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
        },
        {
          provider: 'supabase',
          policy: [
            {
              risk_id: 'supabase.read-data',
              quota: 50,
              rate_limit: { max: 10, window_seconds: 60 },
            },
            {
              risk_id: 'supabase[preview].bulk-row-write',
              quota: 1,
              rate_limit: { max: 1, window_seconds: 60 },
            },
          ],
        },
      ],
      period: { kind: 'one-off' },
    }),
  );
  await page.getByRole('button', { name: 'Check and load' }).click();

  // What passes fills the form; what cannot resolve is listed, not loaded.
  await expect(page.getByText(/Loaded \d+ risks on 2 connections/)).toBeVisible();
  await expect(
    page.getByText(/No selected resource of "Acme Supabase" is labelled "preview"/),
  ).toBeVisible();
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR');
  await expect(page.getByLabel('Include GitHub acme-org')).toBeChecked();
  await expect(page.getByRole('button', { name: '1 of 3 resources' })).toBeVisible();
  await expect(page.getByLabel('Period')).toHaveValue('one-off');
  await expect(page.getByTestId('summary-quantities')).toContainText('in total');

  const issue = page.getByRole('button', { name: 'Issue mission' });
  await expect(issue).toBeEnabled();
  await issue.click();
  const first = await revealedToken(page);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).not.toContainText('`acme/web`');
  await page.getByRole('button', { name: 'I copied the token' }).click();
  await expect(page.getByRole('heading', { name: /Review the pricing PR/ })).toBeVisible();

  // Duplicate: same policy, its own token.
  await page.getByRole('link', { name: 'Duplicate' }).click();
  await expect(page.getByText('Duplicating “Review the pricing PR”')).toBeVisible();
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR (copy)');
  await expect(page.getByLabel('Include Supabase Acme Supabase')).toBeChecked();
  await expect(page.getByRole('button', { name: '1 of 3 resources' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue mission' }).click();
  const second = await revealedToken(page);
  expect(second).not.toBe(first);
  expect(await checkToken(request, first)).toMatchObject({ outcome: 'verified' });
  expect(await checkToken(request, second)).toMatchObject({ outcome: 'verified' });
});
