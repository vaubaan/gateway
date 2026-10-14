/**
 * Connecting an account with a token pasted by hand, beside the company app
 * (ADR token-connections-beside-the-integration-app), in a browser against the
 * ephemeral instance. The providers are mocked in the launcher: nothing
 * reaches a network.
 *
 *   - Supabase has no company app here: the token is the way offered, with
 *     the guide its plugin declares; a personal access token is pasted,
 *     checked at the mocked Supabase, and the account page says who it acts
 *     as. The token is never shown back.
 *   - GitHub has its company app: the app is the way offered, and "Use a
 *     token instead" is one click away; a classic token is refused by its
 *     shape before GitHub is asked.
 *
 * `E2E_V5_PK_SHOTS` names a folder: the connect pages are captured there at
 * 1440×900 and 390 px wide, light and dark (design review).
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, signInAs, upstreamLog } from './browser';
import { E2E_USER } from './instance';

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

test('Supabase without a company app: the token is the way, guided, checked, never shown back', async ({
  page,
  request,
}) => {
  await signIn(page);
  // The picker says how: a token to paste, no company app needed.
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
  // The permissions come from the plugin's declaration, each with what it is for.
  const permissions = page.getByTestId('token-permissions');
  await expect(permissions).toContainText('Database');
  await expect(permissions).toContainText('Edge Functions');
  await expect(guide).toContainText('Choose an expiry of about 90 days');
  await expect(page.getByText('A shared service account is fine')).toBeVisible();
  // No app way to switch to: none is registered.
  await expect(page.getByTestId('connect-other-way')).toHaveCount(0);
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

test('GitHub with its company app: the app first, a token one click away, a classic token refused', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/accounts/new/github');
  await expect(page.getByRole('button', { name: 'Continue to GitHub' })).toBeVisible();
  const other = page.getByTestId('connect-other-way');
  await expect(other).toHaveText('Use a token instead');
  await captureAll(page, 'connect-github-app');

  await other.click();
  await expect(page).toHaveURL(/method=api-key/);
  await expect(page.getByTestId('token-permissions')).toContainText('Contents');
  const unavailable = page.getByTestId('token-unavailable');
  await expect(unavailable).toContainText('github__mint_install_token');
  await expect(unavailable).toContainText('needs the GitHub App');
  await expect(page.getByTestId('connect-other-way')).toHaveText(
    'Connect through your company’s GitHub app instead',
  );
  await captureAll(page, 'connect-github-token');

  // A classic token does not have the shape: refused before GitHub is asked, never echoed.
  const classic = `ghp_${randomBytes(18).toString('hex')}`;
  const field = page.getByLabel(/Fine-grained personal access token/);
  await field.fill(classic);
  await page.getByRole('button', { name: 'Check and connect' }).click();
  await expect(page).toHaveURL(/method=api-key/);
  await expect(page.getByLabel(/Fine-grained personal access token/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(await page.content()).not.toContain(classic);
});
