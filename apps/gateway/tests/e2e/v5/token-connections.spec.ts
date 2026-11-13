/**
 * Connecting an account with a token pasted by hand, the one way of
 * connecting these services (ADR one-place-to-authorize-services-token-first),
 * in a browser against the ephemeral instance. The providers are mocked in
 * the launcher: nothing reaches a network.
 *
 *   - Supabase: a personal access token, with the guide its plugin declares,
 *     pasted, checked at the mocked Supabase; the account page says who it
 *     acts as. The token is never shown back.
 *   - GitHub: a fine-grained token, its permissions listed; a classic token
 *     is refused by its shape before GitHub is asked.
 *   - Railway: a workspace token, the account token second; the token pasted
 *     is checked at the mocked Railway and the account page names its
 *     workspace.
 *   - Vercel: a token for a team or for one project, chosen by a radio that
 *     shows only that alternative's steps and field; a project token is
 *     checked against that project and the account is named after it.
 *
 * `E2E_V5_PK_SHOTS` names a folder: the connect pages are captured there at
 * 1440×900 and 390 px wide, light and dark (design review).
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import { RAILWAY_GRAPHQL_URL } from '@vaubaan/plugin-railway';

import { routeToInstance, signInAs, upstreamLog } from './browser';
import { E2E_USER, MOCK_VERCEL_PROJECT } from './instance';

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_USER);
});

async function signIn(page: Page, returnTo = '/accounts'): Promise<void> {
  await page.goto(`/auth/login?return_to=${returnTo}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

/** Captures the page in both widths and both themes when a folder is named. */
async function captureAll(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_PK_SHOTS;
  if (!dir) return;
  const url = page.url();
  for (const theme of ['light', 'dark'] as const) {
    await page
      .context()
      .addCookies([{ name: 'vaubaan_theme', value: theme, url: new URL(url).origin }]);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.screenshot({
        path: `${dir}/${name}-${viewport.name}-${theme}.png`,
        fullPage: true,
      });
    }
  }
  await page.context().clearCookies({ name: 'vaubaan_theme' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
}

test('Supabase: the token is the way, guided, checked, never shown back', async ({
  page,
  request,
}) => {
  await signIn(page);
  // The picker says how: a token to paste.
  await page.goto('/accounts/new');
  const card = page.getByTestId('service-supabase');
  await expect(card).toContainText('paste: personal access token');
  await card.click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Connect a Supabase account$/);
  const guide = page.getByTestId('token-guide');
  await expect(guide.getByRole('heading', { name: 'Create the token at Supabase' })).toBeVisible();
  await expect(
    guide.getByRole('link', { name: 'Open the token page at Supabase' }),
  ).toHaveAttribute('href', 'https://supabase.com/dashboard/account/tokens');
  // The permissions come from the plugin's declaration, by name and access, without their tools.
  const permissions = page.getByTestId('token-permissions');
  await expect(permissions).toContainText('Database');
  await expect(permissions).toContainText('Edge Functions');
  await expect(guide).toContainText('Choose an expiry of about 90 days');
  await expect(page.getByText('A shared service account is fine')).toBeVisible();
  await captureAll(page, 'connect-supabase-token');

  const token = `sbp_fc${randomBytes(20).toString('hex')}`;
  await page.getByLabel(/Personal access token/).fill(token);
  await page.getByRole('button', { name: 'Check and connect' }).click();

  // The account page: who the token acts as, the token itself nowhere.
  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Supabase$/);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByTestId('account-facts')).toContainText('acts as Acme');
  await expect(page.getByTestId('account-facts')).toContainText('no expiry known');
  expect(await page.content()).not.toContain(token);
  await expect(page.getByText('abcdefghijklmnopqrst')).toBeVisible();

  const log = await upstreamLog(request);
  expect(log.calls.some((c) => c.url === 'https://api.supabase.com/v1/organizations')).toBe(true);
});

test('GitHub: a fine-grained token, its permissions listed, a classic token refused', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/accounts/new/github');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Connect a GitHub account$/);
  // How wide to grant, and why, above the steps: the mission narrows it.
  await expect(page.getByTestId('token-reach')).toContainText('Only select repositories');
  await expect(page.getByTestId('token-permissions')).toContainText('Tick all of them');
  await expect(page.getByTestId('token-permissions')).toContainText('Contents');
  await expect(page.getByTestId('token-permissions')).toContainText('Workflows');
  // One way of connecting: nothing else is offered.
  await expect(page.getByRole('button', { name: 'Continue to GitHub' })).toHaveCount(0);
  await captureAll(page, 'connect-github-token');

  // A classic token does not have the shape: refused before GitHub is asked, never echoed.
  const classic = `ghp_${randomBytes(18).toString('hex')}`;
  const field = page.getByLabel(/Fine-grained personal access token/);
  await field.fill(classic);
  await page.getByRole('button', { name: 'Check and connect' }).click();
  await expect(page).toHaveURL(/\/accounts\/new\/github\?notice=/);
  await expect(page.getByLabel(/Fine-grained personal access token/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(await page.content()).not.toContain(classic);
});

test('Railway: a workspace token, checked, named by its workspace', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/accounts/new');
  const card = page.getByTestId('service-railway');
  await expect(card).toContainText('paste: workspace token');
  await card.click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Connect a Railway account$/);
  const guide = page.getByTestId('token-guide');
  await expect(guide).toContainText('a workspace token reaches that workspace only');
  await expect(guide).toContainText('Choose No workspace instead only for an account token');
  await expect(guide).toContainText('project token is not accepted');
  await captureAll(page, 'connect-railway-token');

  const token = randomBytes(16).toString('hex');
  await page.getByLabel(/Workspace token/).fill(token);
  await page.getByRole('button', { name: 'Check and connect' }).click();

  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Railway$/);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByTestId('account-facts')).toContainText('acts as the vaubaan workspace');
  expect(await page.content()).not.toContain(token);
  await expect(page.getByText('gateway', { exact: true })).toBeVisible();

  const log = await upstreamLog(request);
  expect(log.calls.some((c) => c.url === RAILWAY_GRAPHQL_URL)).toBe(true);
});

test('Vercel: a team or one project, chosen before the steps; a project token named by its project', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto('/accounts/new/vercel');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Connect a Vercel account$/);
  const guide = page.getByTestId('token-guide');
  const team = page.getByTestId('token-alternative-team');
  const project = page.getByTestId('token-alternative-project');

  // Team first: its step and field show, the project's do not.
  await expect(team).toBeChecked();
  await expect(guide.getByText(/copy the Team ID/)).toBeVisible();
  await expect(guide.getByText(/copy the Project ID/)).toBeHidden();
  await expect(page.getByLabel(/Team ID/)).toBeVisible();
  await expect(page.getByLabel(/Project ID/)).toBeHidden();

  await project.check();
  await expect(guide.getByText(/copy the Project ID/)).toBeVisible();
  await expect(guide.getByText(/copy the Team ID/)).toBeHidden();
  await expect(page.getByLabel(/Team ID/)).toBeHidden();
  await captureAll(page, 'connect-vercel-project-token');
  await project.check(); // captureAll reloads the page: choose again

  const token = `vcp_${randomBytes(16).toString('hex')}`;
  await page.getByLabel(/Access token/).fill(token);
  await page.getByLabel(/Project ID/).fill(MOCK_VERCEL_PROJECT);
  await page.getByRole('button', { name: 'Check and connect' }).click();

  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByTestId('account-facts')).toContainText('acts as the site project');
  expect(await page.content()).not.toContain(token);

  const log = await upstreamLog(request);
  const projectReads = log.calls.filter((c) =>
    c.url.includes(`/v9/projects/${MOCK_VERCEL_PROJECT}`),
  );
  expect(projectReads.length).toBeGreaterThan(0);
  expect(projectReads.every((c) => !c.url.includes('teamId='))).toBe(true);
});
