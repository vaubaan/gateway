/**
 * Two sign-in providers on one instance, in a browser (spec §4.2 Settings →
 * Sign-in and People, §6; ADR sign-in-providers-admission-and-admin-rule): the
 * administrator adds GitHub (the in-process `FakeGithub`) beside the company
 * directory (the `FakeIdp`) from Settings → Sign-in, the sign-in page then offers
 * both, an uninvited GitHub address is refused, invited from People it is
 * admitted, and the provider is removed again — asked first. Every page is also
 * checked for the security headers the application sets.
 *
 * GitHub stays a provider only for the length of this spec: the others start a
 * sign-in with `/auth/login`, which goes straight to the one provider.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_OPERATOR, GITHUB_SIGN_IN_BASE, GITHUB_SIGN_IN_CLIENT } from './instance';

const GUEST = { id: 77_001, login: 'lin-guest', email: 'lin@guest.example.org' } as const;

/** Keeps screenshots of a page when `E2E_V5_SCREENSHOT_DIR` names a folder: two sizes, two themes. */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (!dir) return;
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // Let the theme's colour transitions finish before the picture.
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const res = await request.post(controlUrl('/github/cleanup'));
  if (!res.ok()) throw new Error(`github/cleanup answered ${res.status()}`);
}

async function nextGithubUser(request: APIRequestContext, user: typeof GUEST): Promise<void> {
  const res = await request.post(controlUrl('/github/next-user'), { data: user });
  if (!res.ok()) throw new Error(`github/next-user answered ${res.status()}`);
}

async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

test.beforeEach(async ({ context, request }) => {
  await cleanup(request);
  await routeToInstance(context);
});

test.afterEach(async ({ request }) => {
  await cleanup(request);
});

test('an administrator adds GitHub, an invited address signs in through it, and it is removed again', async ({
  page,
  request,
}) => {
  // The operator signs in through the company directory, the one provider so far.
  await signInAs(request, E2E_OPERATOR);
  await page.goto('/auth/login?return_to=/admin/identity-provider');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign-in');
  const table = page.getByTestId('sign-in-providers');
  await expect(table.getByRole('row')).toHaveCount(2); // header + the directory

  // The application sets its own security headers, whatever proxy is in front.
  const response = await page.goto('/admin/identity-provider');
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
  expect(headers['strict-transport-security']).toBe('max-age=31536000');

  // Add GitHub: the callback address comes first, then the fields.
  await page.getByRole('link', { name: 'Add GitHub' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add GitHub sign-in');
  await expect(page.getByText(/\/auth\/callback\/github$/)).toBeVisible();
  await page.getByLabel(/^GitHub Enterprise Server address/).fill(GITHUB_SIGN_IN_BASE);
  await page.getByLabel('Client ID').fill(GITHUB_SIGN_IN_CLIENT.clientId);
  await page.getByLabel('Client secret').fill(GITHUB_SIGN_IN_CLIENT.clientSecret);
  // GitHub is open to anyone: "everyone the directory signs in" is not offered.
  await expect(page.getByRole('radio', { name: /^Everyone your directory/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Invited people only' })).toBeChecked();
  await snap(page, 'settings-sign-in-add-github');
  await page.getByRole('button', { name: 'Add the provider' }).click();

  await expect(page.getByTestId('idp-saved')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table).toContainText('invited people only');
  await expect(table).toContainText('open to anyone');
  // Saved off: it is switched on after a test (ADR administrators-live-in-the-instance).
  await expect(table).toContainText('off: test it first');
  await snap(page, 'settings-sign-in');

  // The test opens GitHub in another window and signs nobody in: this session stays.
  await nextGithubUser(request, GUEST);
  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('test-provider-github').click(),
  ]);
  await popup.waitForURL(/\/admin\/identity-provider\/github\/test/);
  await expect(popup.getByTestId('test-passed')).toContainText(GUEST.email);
  await expect(popup.getByTestId('test-passed')).toContainText('refused');
  await snap(popup, 'settings-sign-in-test');
  await popup.close();
  await page.reload();
  await page.getByTestId('enable-provider-github').click();
  await expect(page.getByTestId('idp-enabled')).toBeVisible();

  // Signed out, the sign-in page offers both providers.
  await signOut(page);
  await page.goto('/login');
  const buttons = page
    .getByTestId('sign-in-providers')
    .getByRole('link', { name: /^Continue with / });
  await expect(buttons).toHaveText(['Continue with idp.e2e.test', 'Continue with GitHub']);
  await snap(page, 'login-two-providers');

  // An address nobody invited is refused, with the reason.
  await nextGithubUser(request, GUEST);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByTestId('login-error')).toContainText('not invited');

  // The operator invites it from People.
  await signInAs(request, E2E_OPERATOR);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with idp.e2e.test' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.goto('/admin/users');
  await page.getByLabel('Email address').fill(GUEST.email);
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByTestId('invitation-list')).toContainText(GUEST.email);
  await expect(page.getByTestId('invitations')).toContainText('not yet');
  await expect(page.getByTestId('people')).toContainText('Signed in with');
  await snap(page, 'settings-people');

  // Invited, the GitHub account is admitted: one more person, signed in with GitHub.
  await signOut(page);
  await nextGithubUser(request, GUEST);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // The operator removes GitHub: asked first, with the person it concerns.
  await signOut(page);
  await signInAs(request, E2E_OPERATOR);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with idp.e2e.test' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByTestId('people')).toContainText(GUEST.login);
  await expect(page.getByTestId('invitations')).toContainText('yes');
  await page.goto('/admin/identity-provider');
  await page.getByRole('button', { name: 'Remove GitHub' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 person has signed in through it');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('idp-removed')).toContainText('their sessions are over');
  await expect(page.getByTestId('sign-in-providers').getByRole('row')).toHaveCount(2);
});
