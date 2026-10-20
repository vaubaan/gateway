/**
 * Local accounts in a browser (spec §0 "Local account", §4.2 Settings → Sign-in,
 * People and Security, §6, §7.1; ADR local-accounts-sign-in-provider): the
 * administrator adds local accounts from Settings → Sign-in, invites an address
 * from People and copies the link (the ephemeral instance sends no mail), the
 * invited person creates their account on it, signs in with the password, enrols
 * a second factor from Settings → Security (the spec reads the secret from the
 * page and computes the code, as an authenticator app would), reads the recovery
 * codes once, and signs in again with one; then the first administrator is
 * created from the setup page and their first sign-in enrols the factor before
 * the session exists. Every page is also checked for the security headers.
 *
 * Local accounts stay a provider only for the length of this spec: the others
 * start a sign-in with `/auth/login`, which goes straight to the one provider.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import { routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_OPERATOR, PUBLIC_URL } from './instance';

const GUEST_EMAIL = 'lin@guest.example.org';
const GUEST_PASSWORD = 'a sentence lin remembers';
const OPS_PASSWORD = 'the operator sentence';
const LINK = /https:\/\/gateway\.e2e\.test\/account\/create\?token=[A-Za-z0-9_-]+/;
const RECOVERY_CODE = /^[a-z2-7]{5}-[a-z2-7]{5}$/;

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
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function control(request: APIRequestContext, path: string): Promise<void> {
  const res = await request.post(controlUrl(path));
  if (!res.ok()) throw new Error(`${path} answered ${res.status()}`);
}

async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/** The operator, through the company directory (chosen on the sign-in page), landing on `path`. */
async function operatorAt(page: Page, request: APIRequestContext, path: string): Promise<void> {
  await signInAs(request, E2E_OPERATOR);
  await page.goto(`/login?return_to=${encodeURIComponent(path)}`);
  await page.getByRole('link', { name: 'Continue with idp.e2e.test' }).click();
}

/** The code an authenticator app shows now for the secret the page displays. */
async function codeShownNow(page: Page): Promise<string> {
  // The `code` element alone: the block also carries its copy button.
  const shown = (await page.getByTestId('totp-secret').locator('code').innerText()).replace(
    /\s/g,
    '',
  );
  const bytes = base32Decode(shown);
  if (!bytes || bytes.length === 0) throw new Error(`not a base32 secret: ${shown}`);
  return totpCode(bytes, totpStepOf(Date.now()));
}

/** The recovery codes of the notice that shows them once. */
async function recoveryCodesOf(page: Page): Promise<string[]> {
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('Second factor set up');
  const lines = (await notice.innerText()).split('\n').map((line) => line.trim());
  return lines.filter((line) => RECOVERY_CODE.test(line));
}

async function passwordSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  const form = page.getByTestId('password-sign-in');
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

test.beforeEach(async ({ context, request }) => {
  await control(request, '/local/cleanup');
  await routeToInstance(context);
});

test.afterEach(async ({ request }) => {
  await control(request, '/local/cleanup');
});

test('an invited person creates a local account on the link, signs in, enrols a second factor and uses a recovery code', async ({
  page,
  request,
}) => {
  // The operator adds local accounts: nothing to register anywhere.
  await operatorAt(page, request, '/admin/identity-provider');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign-in');
  await page.getByRole('link', { name: 'Add local accounts' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add local accounts');
  await expect(page.getByText(/Nothing to register anywhere/)).toBeVisible();
  await snap(page, 'settings-sign-in-add-local');
  await page.getByRole('button', { name: 'Add the provider' }).click();
  await expect(page.getByTestId('idp-saved')).toBeVisible();
  const table = page.getByTestId('sign-in-providers');
  await expect(table.getByRole('row')).toHaveCount(3); // header, the directory, local accounts
  await expect(table).toContainText('Local accounts');
  await expect(table).toContainText('kept by this gateway');

  // People: inviting an address hands the link over, since this gateway sends no mail.
  await page.goto('/admin/users');
  await expect(page.getByTestId('invitations')).toContainText('sends no mail');
  await page.getByLabel('Email address').fill(GUEST_EMAIL);
  await page.getByRole('button', { name: 'Invite' }).click();
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('Hand them this link');
  const link = (await notice.innerText()).match(LINK)?.[0];
  if (!link) throw new Error('no account link in the notice');
  await snap(page, 'settings-people-local-link');

  // The invited person creates the account: the address shown, a password twice, then the home.
  await signOut(page);
  const response = await page.goto(link);
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Create your account');
  const form = page.getByTestId('choose-password');
  await expect(form.getByLabel('Email address')).toHaveValue(GUEST_EMAIL);
  await form.getByLabel(/^Password/).fill(GUEST_PASSWORD);
  await form.getByLabel('The same password again').fill(GUEST_PASSWORD);
  await snap(page, 'account-create');
  await form.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // The link is spent: opened again, it says so and nothing else.
  await signOut(page);
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link cannot be used');

  // The sign-in page takes the password; a wrong one gets the one sentence.
  await passwordSignIn(page, GUEST_EMAIL, 'not the password');
  await expect(page.getByTestId('login-error')).toContainText('not right');
  await snap(page, 'login-local');
  await passwordSignIn(page, GUEST_EMAIL, GUEST_PASSWORD);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Settings → Security: the second factor, from a secret the page shows and a first code.
  await page.goto('/settings');
  await page.getByTestId('settings-security').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Security');
  await expect(page.getByTestId('second-factor')).toContainText('Not set up');
  await page.getByTestId('begin-second-factor').click();
  await expect(page.getByTestId('otpauth-qr')).toBeVisible();
  await snap(page, 'settings-security-enrol');
  await page.getByLabel(/^The code the app shows now/).fill(await codeShownNow(page));
  await page.getByRole('button', { name: 'Confirm' }).click();
  const codes = await recoveryCodesOf(page);
  expect(codes).toHaveLength(8);
  await expect(page.getByTestId('second-factor')).toContainText('8 recovery codes left');
  await snap(page, 'settings-security-codes');

  // From now on the password alone is not enough: a recovery code signs in once.
  await signOut(page);
  await passwordSignIn(page, GUEST_EMAIL, GUEST_PASSWORD);
  await expect(page).toHaveURL(`${PUBLIC_URL}/login/code`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('One more step');
  await page.getByLabel(/^Code/).fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('login-error')).toContainText('not accepted');
  await snap(page, 'login-code');
  await page.getByLabel(/^Code/).fill(codes[0] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.goto('/settings/security');
  await expect(page.getByTestId('second-factor')).toContainText('7 recovery codes left');

  // "Forgot your password" says beforehand that this gateway sends no mail.
  await signOut(page);
  await page.goto('/account/forgot');
  await expect(page.getByText(/sends no mail/)).toBeVisible();
  await snap(page, 'account-forgot');
});

test('the first administrator is created from the setup page; their first sign-in enrols the second factor before the session', async ({
  page,
  request,
}) => {
  await control(request, '/local/setup');
  // The setup page takes any address: the holder of the setup link names the first administrator.
  await operatorAt(page, request, '/admin/first-administrator');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Create the first administrator',
  );
  const form = page.getByTestId('first-admin-form');
  await form.getByLabel('Address').fill(E2E_OPERATOR.email);
  await form.getByLabel(/^Password/).fill(OPS_PASSWORD);
  await form.getByLabel('The same password again').fill(OPS_PASSWORD);
  await snap(page, 'admin-first-administrator');
  await form.getByRole('button', { name: 'Create the account' }).click();
  await expect(page.getByTestId('notice')).toContainText(
    `Account of ${E2E_OPERATOR.email} created`,
  );

  // An administrator from its creation: the password leads to the enrolment, not to a session.
  await signOut(page);
  await passwordSignIn(page, E2E_OPERATOR.email, OPS_PASSWORD);
  await expect(page).toHaveURL(`${PUBLIC_URL}/login/second-factor`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set up your second factor');
  await expect(page.getByTestId('otpauth-qr')).toBeVisible();
  await snap(page, 'login-second-factor');
  await page.getByLabel(/^The code the app shows now/).fill('000000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('login-error')).toContainText('not accepted');
  await page.getByLabel(/^The code the app shows now/).fill(await codeShownNow(page));
  await page.getByRole('button', { name: 'Confirm' }).click();
  // The session exists now; the recovery codes are shown once, on Security.
  await expect(page).toHaveURL(/\/settings\/security\?notice=/);
  const codes = await recoveryCodesOf(page);
  expect(codes).toHaveLength(8);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // ...and it administers the gateway.
  await page.goto('/admin');
  await expect(page.getByTestId('setup-checklist')).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByTestId('people')).toContainText('Email and password');
});
