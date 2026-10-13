/**
 * The home of someone who has nothing yet, and the pages around the
 * application, in a browser against the ephemeral instance: the sign-in, the
 * first run, "not found" inside and outside the shell, and the refusal of a
 * forwarded request URL — each in the theme the person chose.
 *
 * What waits and what runs on the home is exercised where it happens: by
 * "exhaust and claim" and "approve an action".
 */
import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { PUBLIC_URL } from './instance';

/** Somebody no other spec signs in as: they own nothing and created nothing. */
const NEWCOMER = { sub: 'idp|nora', email: 'nora@example.com', name: 'Nora Lindqvist' } as const;

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, NEWCOMER);
});

/** Signs the newcomer in and waits for the home: the next navigation starts from a settled page. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/auth/login?return_to=/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('the sign-in names the gateway, offers one way in, and leads to the one home', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Sign in to ${new URL(PUBLIC_URL).host}`,
  );
  await expect(page.getByRole('main')).toContainText('Nobody has a password here.');
  await expect(page.getByRole('button')).toHaveText([/^Continue with /]);
  await expect(page.getByTestId('build-footer')).toBeVisible();
  // No shell around it: the page is a column of its own.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await snap(page, 'login');

  // A failed attempt says why, by its code; an unknown code says nothing.
  await page.goto('/login?error=login-expired');
  await expect(page.getByTestId('login-error')).toContainText('The sign-in attempt expired');
  await page.goto('/login?error=not-a-code');
  await expect(page.getByTestId('login-error')).toHaveCount(0);

  await page.getByRole('button', { name: /^Continue with / }).click();
  // Signed in from the sign-in page itself: who is signed in, and the way to the home.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You are signed in');
  await expect(page.getByTestId('signed-in-as')).toContainText(NEWCOMER.name);
  await expect(page.getByTestId('signed-in-as')).toContainText(NEWCOMER.email);
  await snap(page, 'login-signed-in');
  await page.getByRole('link', { name: 'Open the gateway' }).click();
  await expect(page).toHaveURL(new RegExp(`^${PUBLIC_URL}/$`));
});

test('a first run says what the product is, draws the model and leads to the first account', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Nora');
  const main = page.getByRole('main');
  await expect(main).toContainText('without ever holding a credential');
  // The model, in five nodes read left to right.
  const model = page.getByRole('list', { name: 'How it fits together' });
  await expect(model.getByRole('listitem')).toHaveText([
    /^Account/,
    /^Mission/,
    /^Key/,
    /^Agent/,
    /^Activity/,
  ]);
  // Three steps; the first one is the next thing to do and the one accent of the page.
  const steps = page.getByTestId('now-steps');
  await expect(steps.getByRole('listitem')).toHaveCount(3);
  await expect(steps).toContainText('Connect an account');
  await expect(steps).toContainText('Give an agent a mission');
  await expect(steps).toContainText('Paste the kit into your agent');
  // Nobody administers from here unless they do: no setup list for a teammate.
  await expect(page.getByTestId('now-setup')).toHaveCount(0);
  // Nothing waits, nothing runs: the home shows neither list.
  await expect(page.getByTestId('now-waiting')).toHaveCount(0);
  await expect(page.getByTestId('now-running')).toHaveCount(0);
  await expect(page.getByTestId('open-request-count')).toHaveCount(0);
  // The page holds at 1280×800 without scrolling sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await snap(page, 'now-first-run');

  await steps.getByRole('link', { name: 'Connect an account' }).click();
  await expect(page).toHaveURL(/\/accounts\/new$/);

  // The inbox of someone nobody asked anything: one sentence.
  await page.goto('/waiting');
  await expect(page.getByTestId('waiting-empty')).toContainText('Nothing waits for you.');
});

test('"not found" is one answer inside the shell and one outside it', async ({ page, browser }) => {
  await signIn(page);
  const inside = await page.goto('/missions/no-such-mission');
  expect(inside?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
  await expect(page.getByTestId('not-found')).toContainText('or is not yours to see');
  // Still inside the application: the navigation is there, and the way home.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.getByTestId('not-found').getByRole('link', { name: 'Go to Now' }).click();
  await expect(page).toHaveURL(new RegExp(`^${PUBLIC_URL}/$`));

  // Without a session an unknown address says nothing of what exists.
  const anonymous = await browser.newContext();
  await routeToInstance(anonymous);
  const visitor = await anonymous.newPage();
  const outside = await visitor.goto('/no-such-page');
  expect(outside?.status()).toBe(404);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('This page does not exist');
  await expect(visitor.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(visitor.getByTestId('build-footer')).toBeVisible();
  await snap(visitor, 'not-found');
  await anonymous.close();
});

test('the pages a handler answers itself follow the theme the person chose', async ({
  page,
  context,
}) => {
  await signIn(page);
  // A request that is nobody's: the forwarded URL answers 403 with one sentence.
  const address = '/r/00000000-0000-4000-8000-000000000000';
  const plain = await page.goto(address);
  expect(plain?.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not yours to answer');
  await expect(page.getByText('This request is addressed to its creator.')).toBeVisible();
  // Light by default, in the tokens of the interface.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await paper()).toBe('rgb(255, 255, 255)');
  // The system asks for dark: the page follows it.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await paper()).toBe('rgb(15, 17, 21)');
  await page.emulateMedia({ colorScheme: 'light' });

  // The person chose dark in the application: the document arrives dark, with no script.
  await context.addCookies([{ name: 'vaubaan_theme', value: 'dark', url: PUBLIC_URL }]);
  const dark = await page.goto(address);
  expect(await dark?.text()).toMatch(/<html lang="en" data-theme="dark">/);
  expect(await paper()).toBe('rgb(15, 17, 21)');
  expect(await page.locator('script').count()).toBe(0);
  await snap(page, 'request-forbidden-dark');

  // The same address inside the application says the same sentence, and nothing more.
  await page.goto(address.replace('/r/', '/waiting/'));
  await expect(page.getByTestId('request-forbidden')).toContainText(
    'This request is addressed to its creator.',
  );
});
