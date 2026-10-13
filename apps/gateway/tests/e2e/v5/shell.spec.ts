/**
 * The frame every page shares, in a browser, against the ephemeral instance:
 * the side navigation and its collapsed form, the theme toggle (three states,
 * kept across a reload, rendered by the server so nothing flashes), the
 * permanent redirects from the paths the interface had before its words
 * changed, Settings with its local navigation, and the gallery of `/design`.
 */
import { expect, test, type Page } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { E2E_OPERATOR, E2E_USER, localOrigin, PUBLIC_URL } from './instance';

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_USER);
});

async function signIn(page: Page, returnTo = '/'): Promise<void> {
  await page.goto(`/auth/login?return_to=${returnTo}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

const ENTRIES = [
  'Now',
  'Waiting for you',
  'Missions',
  'Accounts',
  'Activity',
  'Reference',
  'Settings',
];

test('one home, seven entries, the person and the theme at the foot', async ({ page }) => {
  // No session: the home sends the visitor to the sign-in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page);

  // One home: the sign-in lands on it, and the brand leads back to it.
  await expect(page).toHaveURL(new RegExp(`^${PUBLIC_URL}/$`));
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText(ENTRIES.map((entry) => new RegExp(`^${entry}`)));
  await expect(nav.getByRole('link', { name: 'Now' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  // The navigation is a column beside the page, not a bar above it.
  const side = await page.locator('aside').boundingBox();
  const main = await page.locator('main').boundingBox();
  expect(side?.width).toBe(220);
  expect(main?.x).toBeGreaterThanOrEqual(220);

  // Every entry leads to a page inside the same shell, and is then the current one.
  for (const entry of ENTRIES.slice(1)) {
    await nav.getByRole('link', { name: entry }).click();
    await expect(nav.getByRole('link', { name: entry })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
  await page.getByRole('link', { name: /^Vaubaan/ }).click();
  await expect(page).toHaveURL(new RegExp(`^${PUBLIC_URL}/$`));

  // The person: a name, an email, and "Sign out" behind the control.
  await expect(page.getByTestId('user-menu')).toContainText(E2E_USER.email);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await page.getByTestId('user-menu').click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await expect(page.getByTestId('user-menu')).toBeFocused();

  // The keyboard reaches the page first.
  await page.goto('/missions');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to the page' })).toBeFocused();
  await snap(page, 'shell-1280');
});

test('the navigation collapses to its icons in a narrow window and keeps its names', async ({
  page,
}) => {
  await signIn(page, '/settings');
  await page.setViewportSize({ width: 900, height: 800 });
  const nav = page.getByRole('navigation', { name: 'Main' });
  expect((await page.locator('aside').boundingBox())?.width).toBe(56);
  // The names are still there for assistive technology and as the title of each link.
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Accounts' })).toHaveAttribute('title', 'Accounts');
  // The page does not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
  await snap(page, 'shell-collapsed-900');

  // A phone: the navigation is a bar above the page.
  await page.setViewportSize({ width: 390, height: 780 });
  const bar = await page.locator('aside').boundingBox();
  expect(bar?.width).toBe(390);
  expect(bar?.height).toBeLessThan(64);
  await expect(nav.getByRole('link', { name: 'Waiting for you' })).toBeVisible();
  await snap(page, 'shell-phone-390');
});

test('the theme has three states, is kept across a reload and is rendered by the server', async ({
  page,
  context,
}) => {
  await signIn(page, '/missions');
  const html = page.locator('html');
  const toggle = page.getByTestId('theme-toggle');

  // System: no attribute; the style sheet follows the device.
  await expect(html).not.toHaveAttribute('data-theme');
  await expect(toggle).toHaveAttribute('aria-label', 'Theme: System. Switch to Light.');
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await paper()).toBe('rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await paper()).toBe('rgb(15, 17, 21)');
  await page.emulateMedia({ colorScheme: 'light' });

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-label', 'Theme: Dark. Switch to System.');
  expect(await paper()).toBe('rgb(15, 17, 21)');

  // Kept: the choice is a cookie, and the server writes the attribute itself —
  // the document arrives dark, before any script runs.
  const cookie = (await context.cookies()).find((c) => c.name === 'vaubaan_theme');
  expect(cookie?.value).toBe('dark');
  const response = await page.reload();
  expect(await response?.text()).toMatch(/<html[^>]*data-theme="dark"/);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await snap(page, 'shell-dark');

  // Settings offers the same choice by name, and the two controls stay in step.
  await page.goto('/settings');
  await page.getByTestId('settings-theme').getByRole('button', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-label', 'Theme: Light. Switch to Dark.');
  await page.getByTestId('settings-theme').getByRole('button', { name: 'System' }).click();
  await expect(html).not.toHaveAttribute('data-theme');
  expect((await context.cookies()).some((c) => c.name === 'vaubaan_theme')).toBe(false);
});

test('every old path answers with a permanent redirect to the page that replaced it', async ({
  page,
  request,
}) => {
  await signIn(page, '/missions');

  // What the server answers, hop by hop: 308, so a form post keeps its method.
  for (const [from, to] of [
    ['/connections', '/accounts'],
    ['/connections/new', '/accounts/new'],
    ['/connections/new/github', '/accounts/new/github'],
    ['/requests', '/waiting'],
    [
      '/requests/00000000-0000-0000-0000-000000000000',
      '/waiting/00000000-0000-0000-0000-000000000000',
    ],
    ['/audit?decision=refused', '/activity?decision=refused'],
    ['/providers', '/reference'],
    ['/providers/github', '/reference/github'],
  ] as const) {
    const response = await request.get(`${localOrigin()}${from}`, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(response.headers().location, from).toBe(to);
  }
  // The callback a provider was given is part of the protocol: it is served, not redirected.
  const callback = await request.get(`${localOrigin()}/connections/callback/github`, {
    maxRedirects: 0,
  });
  expect(callback.status()).not.toBe(308);
  expect(callback.headers().location ?? '').not.toContain('/accounts/callback');

  // In a browser: an old bookmark and an old deep link land on the new pages.
  await page.goto('/connections');
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await page.goto('/providers/github#risk-github.read-code');
  await expect(page).toHaveURL(/\/reference\/github/);
  await expect(page.getByRole('heading', { name: 'GitHub', level: 1 })).toBeVisible();
  await page.goto('/audit');
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
});

test('Settings leads a person to their own pages and an administrator to the gateway’s', async ({
  page,
  browser,
  request,
}) => {
  await signIn(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const local = page.getByRole('navigation', { name: 'Settings' });
  await expect(local.getByRole('link')).toHaveText(['Preferences', 'Connected apps']);
  await expect(page.getByText('Administration')).toHaveCount(0);
  await local.getByRole('link', { name: 'Connected apps' }).click();
  await expect(page).toHaveURL(/\/delegations$/);
  await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();

  // An administrator: the same shell, the global navigation stays, Administration is listed.
  await signInAs(request, E2E_OPERATOR);
  const context = await browser.newContext();
  await routeToInstance(context);
  const ops = await context.newPage();
  await ops.goto(`${PUBLIC_URL}/auth/login?return_to=/settings`);
  const admin = ops.getByRole('navigation', { name: 'Settings' });
  await expect(admin.getByRole('link')).toHaveText([
    'Preferences',
    'Connected apps',
    'Setup',
    'Sign-in',
    'Company apps',
    'People',
    'Teams',
    'Accounts without owner',
    'Telemetry',
    'Registered apps',
  ]);
  await admin.getByRole('link', { name: 'People' }).click();
  await expect(ops).toHaveURL(/\/admin\/users$/);
  const main = ops.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(main.getByRole('link', { name: 'Missions' })).toBeVisible();
  await expect(
    ops.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'People' }),
  ).toHaveAttribute('aria-current', 'page');
  await snap(ops, 'settings-administration');
  await context.close();
});

test('the gallery shows every component in both themes', async ({ page }) => {
  await signIn(page, '/design');
  await expect(page.getByRole('heading', { name: 'Interface reference', level: 1 })).toBeVisible();
  // One section per entry of its local navigation, each reachable by its anchor.
  const anchors = await page
    .getByRole('navigation', { name: 'Components' })
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(anchors.length).toBeGreaterThanOrEqual(24);
  for (const anchor of anchors) await expect(page.locator(`section${anchor}`)).toHaveCount(1);

  // Every specimen is drawn on a light island and on a dark one, whatever the theme of the page.
  const specimens = page.locator('[data-specimen]');
  expect(await specimens.count()).toBeGreaterThanOrEqual(50);
  const islands = await specimens.evaluateAll((nodes) =>
    nodes.map((node) =>
      [...node.querySelectorAll(':scope > div > [data-theme]')].map((island) => [
        island.getAttribute('data-theme'),
        getComputedStyle(island).backgroundColor,
      ]),
    ),
  );
  for (const pair of islands) {
    expect(pair).toEqual([
      ['light', 'rgb(255, 255, 255)'],
      ['dark', 'rgb(15, 17, 21)'],
    ]);
  }

  // "Show details" adds the detail columns of a table, and the page remembers.
  const people = page.locator('[data-detail-scope="design:people:light"]');
  await expect(people.getByRole('columnheader', { name: 'Key' })).toBeHidden();
  await people.getByRole('button', { name: 'Show details' }).click();
  await expect(people.getByRole('columnheader', { name: 'Key' })).toBeVisible();
  await page.reload();
  await expect(people.getByRole('columnheader', { name: 'Key' })).toBeVisible();
  await people.getByRole('button', { name: 'Hide details' }).click();
  await expect(people.getByRole('columnheader', { name: 'Key' })).toBeHidden();

  // A meter is drawn only near its limit.
  const meters = page.locator('section#meter [data-theme="light"]').first();
  await expect(meters.getByRole('meter')).toHaveCount(2);

  // "why?" unfolds the six words of a permission.
  const editor = page.locator('section#permission [data-theme="light"]').first();
  const row = editor.locator('tr[data-permission="github.read-code"]');
  await row.getByRole('button', { name: 'why?' }).click();
  await expect(editor.getByText('Source may contain secrets committed by mistake.')).toBeVisible();

  // A confirmation states its consequence, keeps the focus inside, and Escape cancels it.
  const dialogs = page.locator('section#dialog [data-theme="light"]').first();
  await dialogs.getByRole('button', { name: 'Open the confirmation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace your key?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Nothing else changes');
  await expect(dialog.getByRole('radio', { name: /Stop the current key now/ })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await dialogs.getByRole('button', { name: 'Open the confirmation' }).click();
  await dialog.getByRole('button', { name: 'Replace key' }).click();
  await expect(page.getByTestId('toasts')).toContainText('Key replaced');
  await snap(page, 'design-gallery');
});
