/**
 * The frame every page shares, in a browser, against the ephemeral instance:
 * the side navigation and its collapsed form, the theme toggle (three states,
 * kept across a reload, rendered by the server so nothing flashes), the
 * permanent redirects from the paths the interface had before its words
 * changed, Settings with its local navigation, and the gallery of `/design`.
 */
import { expect, test, type Page } from '@playwright/test';

import { passSecondFactor, routeToInstance, signInAs } from './browser';
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

test('one home, seven entries, the path above the page, the person and the theme at its end', async ({
  page,
}) => {
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

  // The navigation is a column beside the page; above the page, a bar with the path.
  const side = await page.locator('aside').boundingBox();
  const main = await page.locator('main').boundingBox();
  expect(side?.width).toBe(220);
  expect(main?.x).toBeGreaterThanOrEqual(220);
  const path = page.getByRole('navigation', { name: 'Path' });
  const bar = await page.getByTestId('path-bar').boundingBox();
  expect(bar?.height).toBe(44);
  expect(bar?.y).toBe(0);
  // The path: this gateway, then the section — said once when the page is the
  // section, a link when the page is its own (the first run says "Welcome");
  // the last word is not a link.
  await expect(path.getByRole('link').first()).toContainText('gateway.e2e.test');
  await expect(path).toContainText('Now');
  await expect(path.locator('[aria-current="page"]')).toHaveCount(1);
  // The theme and the person are at the end of the bar.
  await expect(page.getByTestId('path-bar').getByTestId('theme-toggle')).toBeVisible();
  await expect(page.getByTestId('path-bar').getByTestId('user-menu')).toBeVisible();

  // Every entry leads to a page inside the same shell, and is then the current one;
  // the path says the section once, as the page.
  for (const entry of ENTRIES.slice(1)) {
    await nav.getByRole('link', { name: entry }).click();
    await expect(nav.getByRole('link', { name: entry })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(path.locator('[aria-current="page"]')).toHaveText(entry);
    await expect(path.getByRole('link')).toHaveCount(1);
  }
  // A page under a section: the section is a link, the page is the last word.
  await page.goto('/missions/new');
  await expect(path.getByRole('link', { name: 'Missions' })).toBeVisible();
  await expect(path.locator('[aria-current="page"]')).toHaveText('New mission');
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

  // No "More" in a window that has room for the seven entries.
  await expect(page.getByTestId('nav-more')).toBeHidden();
});

/** Nothing of the page is wider than the window: no sideways scroll. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, page.url()).toBeLessThanOrEqual(client);
}

test('on a phone the navigation is a bar of icons WITH their words, and no page scrolls sideways', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 780 });
  const nav = page.getByRole('navigation', { name: 'Main' });

  // A bar at the bottom of the screen, as wide as the screen.
  const bar = await nav.boundingBox();
  expect(bar?.width).toBe(390);
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBe(780);
  expect(bar?.height).toBeLessThanOrEqual(64);

  // Four entries and "More", each an icon and a word a finger can read: the word is drawn.
  const drawn = async (text: string) => {
    const word = nav.getByText(text, { exact: true }).first();
    await expect(word).toBeVisible();
    const box = await word.boundingBox();
    expect(box?.width, text).toBeGreaterThan(10);
    expect(box?.height, text).toBeGreaterThanOrEqual(12);
  };
  for (const word of ['Now', 'Waiting', 'Missions', 'Accounts', 'More']) await drawn(word);
  // The short word is a drawing: the link keeps its full name.
  await expect(nav.getByRole('link', { name: 'Waiting for you' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Now' })).toHaveAttribute('aria-current', 'page');
  // The entries the bar has no room for are not drawn until asked for.
  await expect(nav.getByRole('link', { name: 'Activity' })).toBeHidden();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeHidden();
  await snap(page, 'shell-phone-390');

  // "More" opens them in a sheet above the bar, by touch or by keyboard.
  const more = page.getByTestId('nav-more');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const sheet = page.getByTestId('nav-sheet');
  await expect(sheet.getByRole('link')).toHaveText(['Activity', 'Reference', 'Settings']);
  const sheetBox = await sheet.boundingBox();
  expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeLessThanOrEqual(bar?.y ?? 0);
  await snap(page, 'shell-phone-390-more');
  // Escape closes it and gives the focus back.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  // Going somewhere through the sheet closes it, and "More" is then the current entry.
  await more.click();
  await sheet.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(more).toHaveClass(/navLinkOn/);
  // The local navigation of Settings is rows of chips, not a run-on line.
  const chip = page.getByRole('navigation', { name: 'Settings' }).getByRole('link').first();
  expect((await chip.boundingBox())?.height).toBeGreaterThanOrEqual(32);
  await expectNoSidewaysScroll(page);

  // The page ends above the bar: its last line is not under it.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const footer = await page.getByTestId('build-footer').boundingBox();
  const barNow = await nav.boundingBox();
  expect((footer?.y ?? 0) + (footer?.height ?? 0)).toBeLessThanOrEqual((barNow?.y ?? 0) + 1);

  // No page of the navigation scrolls sideways at 390 px — the reference of a service,
  // whose comparison table scrolls inside its own box, included.
  for (const path of [
    '/',
    '/waiting',
    '/missions',
    '/missions/new',
    '/accounts',
    '/accounts/new',
    '/activity',
    '/reference',
    '/reference/github',
    '/settings/connected-apps',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page);
  }
  await snap(page, 'reference-phone-390');
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
  expect(await paper()).toBe('rgb(2, 8, 23)');
  await page.emulateMedia({ colorScheme: 'light' });

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-label', 'Theme: Dark. Switch to System.');
  expect(await paper()).toBe('rgb(2, 8, 23)');

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
    // Two pages were folded into another: what was shared with a person is a region of
    // Accounts, connected apps are a page of Settings.
    ['/shares', '/accounts'],
    ['/delegations', '/settings/connected-apps'],
  ] as const) {
    const response = await request.get(`${localOrigin()}${from}`, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(response.headers().location, from).toBe(to);
  }
  // A form post to the earlier address of "disconnect an app" keeps its method.
  const revoke = await request.post(`${localOrigin()}/delegations/some-id/revoke`, {
    maxRedirects: 0,
  });
  expect(revoke.status()).toBe(308);
  expect(revoke.headers().location).toBe('/settings/connected-apps/some-id/revoke');
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
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GitHub', level: 2 })).toBeVisible();
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/accounts$/);
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
  // The component gallery is not offered to someone who does not administer…
  await expect(page.getByTestId('settings-interface-reference')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('Interface reference');
  // …and Administration, opened by its address, says so inside the same shell.
  await page.goto('/admin');
  const refused = page.getByTestId('not-administrator');
  await expect(refused).toContainText('You do not administer this gateway');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(7);
  await expect(page.getByTestId('user-menu')).toBeVisible();
  await expect(page.getByTestId('build-footer')).toBeVisible();
  await snap(page, 'not-administrator');
  await refused.getByRole('link', { name: 'Go to Now' }).click();
  await expect(page).toHaveURL(new RegExp(`^${PUBLIC_URL}/$`));
  await page.goto('/settings');
  await local.getByRole('link', { name: 'Connected apps' }).click();
  await expect(page).toHaveURL(/\/settings\/connected-apps$/);
  await expect(page.getByRole('heading', { name: 'Connected apps', level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Connected apps' }),
  ).toHaveAttribute('aria-current', 'page');

  // An administrator: the same shell, the global navigation stays, Administration is listed.
  await signInAs(request, E2E_OPERATOR);
  const context = await browser.newContext();
  await routeToInstance(context);
  const ops = await context.newPage();
  await ops.goto(`${PUBLIC_URL}/auth/login?return_to=/settings`);
  // An administrator always gives the gateway's own second factor.
  await passSecondFactor(ops, request, E2E_OPERATOR.email);
  const admin = ops.getByRole('navigation', { name: 'Settings' });
  await expect(admin.getByRole('link')).toHaveText([
    'Preferences',
    'Connected apps',
    'Setup',
    'Sign-in',
    'People',
    'Teams',
    'Telemetry',
    'Registered apps',
    'Encryption',
  ]);
  // An administrator is offered the interface reference, under Administration.
  await expect(ops.getByTestId('settings-interface-reference')).toContainText(
    'Interface reference',
  );
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
  // People: one line each, the administrator said in words, no button on one's own line.
  const self = ops.getByTestId('people').getByRole('row').filter({ hasText: E2E_OPERATOR.email });
  await expect(self).toContainText('you');
  await expect(self).toContainText('admin');
  await expect(self.getByRole('button')).toHaveCount(0);
  await snap(ops, 'settings-administration');

  // Setup is a checklist that says what is done and what is left, and who administers.
  await admin.getByRole('link', { name: 'Setup' }).click();
  await expect(ops).toHaveURL(/\/admin$/);
  await expect(ops.getByRole('heading', { name: 'Setup', level: 1 })).toBeVisible();
  const checklist = ops.getByTestId('setup-checklist');
  await expect(checklist).toContainText(/\d of \d done/);
  await expect(checklist.getByTestId('setup-sign-in')).toContainText('Sign-in through');
  await expect(checklist.getByTestId('setup-sign-in')).toContainText('done');
  await expect(checklist.getByTestId('setup-address')).toContainText('gateway.e2e.test');
  // A service that needs an OAuth client is not a step while none is declared: nobody
  // asked for it. The administrator declares it from Accounts, when somebody wants it.
  await expect(checklist.getByTestId('setup-oauth-clients')).toHaveCount(0);
  // The one thing left to do carries the page's one primary action.
  await expect(checklist.locator('a[class*="primary"]')).toHaveCount(1);
  await ops.goto('/accounts');
  const gmail = ops.getByTestId('service-gmail');
  await expect(gmail).toContainText('needs its OAuth client · declare it');
  await gmail.click();
  await expect(ops).toHaveURL(/\/accounts\/new\/gmail$/);
  // The OAuth client is declared on the service's connect page, by an administrator.
  await expect(ops.getByTestId('oauth-client-missing')).toBeVisible();
  await expect(ops.getByTestId('oauth-client-form-gmail')).toBeVisible();
  await ops.goto('/admin');
  // The rule is readable by who it names: the listed email, and who it resolves to today.
  const rule = ops.getByTestId('administrators');
  await expect(rule).toContainText(E2E_OPERATOR.email);
  await expect(rule).toContainText('Cannot read a key');
  await snap(ops, 'settings-setup');
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
      ['dark', 'rgb(2, 8, 23)'],
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
