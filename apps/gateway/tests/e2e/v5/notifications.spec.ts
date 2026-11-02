/**
 * Notifications on a device, in a browser (spec §4.2 bis): the home proposes them when
 * something waits and remembers "Not now" on this browser; Settings → Notifications
 * subscribes this device, then renames and removes it; an iPhone not opened from the Home
 * Screen is told to install the interface first; a browser without push is told it cannot.
 *
 * A real `pushManager.subscribe` needs the browser vendor's push service, which a headless
 * browser on a closed network does not reach: the page's service worker container is
 * replaced by a stub that hands out a subscription of the right shape (an FCM endpoint and
 * a real P-256 key), and the browser's permission is stated granted (Chromium's headless
 * shell answers `denied` whatever the context grants). What is tested is the page and the
 * request it posts; the service worker itself is tested in
 * `tests/unit/app/service-worker.test.ts`.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { issueSmallMission, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

/**
 * Replaces the service worker container: `register`, `ready` and `getRegistration` give a
 * registration whose push manager subscribes at once, and remembers the subscription in
 * `localStorage` so that a reload reads it back as a real browser would.
 */
function stubPush(): void {
  const KEY = 'e2e_push_subscription';
  const read = () => {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  };
  const asSubscription = (json: Record<string, unknown>) => ({ ...json, toJSON: () => json });
  const pushManager = {
    getSubscription: async () => {
      const stored = read();
      return stored ? asSubscription(stored) : null;
    },
    subscribe: async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ]);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      const b64 = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const json = {
        endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`,
        expirationTime: null,
        keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) },
      };
      window.localStorage.setItem(KEY, JSON.stringify(json));
      return asSubscription(json);
    },
  };
  // Chromium's headless shell answers `denied` whatever the context grants: the permission
  // the spec grants is stated here too.
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  Object.defineProperty(Notification, 'requestPermission', {
    value: async () => 'granted',
  });
  const registration = { pushManager };
  const container = navigator.serviceWorker;
  Object.defineProperty(container, 'register', { value: async () => registration });
  Object.defineProperty(container, 'getRegistration', { value: async () => registration });
  Object.defineProperty(container, 'ready', { get: () => Promise.resolve(registration) });
}

async function pushContext(context: BrowserContext): Promise<void> {
  await routeToInstance(context);
  await context.grantPermissions(['notifications']);
  await context.addInitScript(stubPush);
}

async function signIn(page: Page, to: string): Promise<void> {
  await page.goto(`/auth/login?return_to=${encodeURIComponent(to)}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

let agent: Agent | null = null;

test.beforeEach(async ({ request }) => {
  await signInAs(request, E2E_USER);
});
test.afterEach(async () => {
  await agent?.close();
  agent = null;
});

test('the home proposes notifications when something waits; Settings subscribes, renames and removes the device', async ({
  context,
  page,
  request,
}) => {
  await pushContext(context);
  // Something waits for Ada: a claim of a mission of hers whose quota is spent.
  const issued = await issueSmallMission(request, 'Read the notification code');
  const executor = (agent = await connectAgent(issued.token));
  const read = () =>
    executor.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });
  await read();
  await read();
  expect((await read()).outcome).toBe('refused');

  // ── The home's one line, and "Not now" remembered by this browser ──────
  await signIn(page, '/');
  const offer = page.getByTestId('push-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('never the arguments');
  await snap(page, 'notifications-home-offer');
  await offer.getByTestId('push-offer-not-now').click();
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('push-offer')).toHaveCount(0);

  // ── Settings → Notifications: this device ───────────────────────────────
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByTestId('no-device')).toBeVisible();
  await snap(page, 'notifications-settings-empty');
  const posted = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/notifications/devices'),
  );
  await page.getByTestId('push-subscribe').click();
  const body = (await posted).postDataJSON() as {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    label: string;
  };
  expect(body.subscription.endpoint).toMatch(/^https:\/\/fcm\.googleapis\.com\/fcm\/send\//);
  expect(Buffer.from(body.subscription.keys.p256dh, 'base64url')).toHaveLength(65);
  expect(Buffer.from(body.subscription.keys.auth, 'base64url')).toHaveLength(16);
  expect(body.label).toMatch(/Chrome/);
  await expect(page.getByTestId('push-subscribed')).toBeVisible();
  const devices = page.getByTestId('devices');
  await expect(devices).toContainText(body.label);
  await expect(devices).toContainText('never');
  // What the page shows of a device is its name and dates, never its subscription.
  expect(await page.content()).not.toContain(body.subscription.keys.p256dh);
  await snap(page, 'notifications-settings-subscribed');

  // ── Rename, then remove, asked first ────────────────────────────────────
  await page.getByTestId('device-rename').click();
  await page.getByLabel('Name of the device').fill('Work laptop');
  await page.getByTestId('device-rename-form').getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByTestId('device-renamed')).toBeVisible();
  await expect(devices).toContainText('Work laptop');

  await page.getByRole('button', { name: 'Remove Work laptop' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Remove Work laptop?');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('device-removed')).toBeVisible();
  await expect(page.getByTestId('no-device')).toBeVisible();
});

test('an iPhone not opened from the Home Screen is told to install the interface first', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent: IPHONE_UA,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await pushContext(context);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: false });
  });
  const page = await context.newPage();
  await signIn(page, '/settings/notifications');
  await expect(page.getByTestId('push-install-first')).toContainText('Add to Home Screen');
  await expect(page.getByTestId('push-subscribe')).toHaveCount(0);
  await snap(page, 'notifications-iphone-install-first');
  await context.close();
});

test('a browser without push is told so in one sentence', async ({ browser }) => {
  const context = await browser.newContext();
  await routeToInstance(context);
  await context.addInitScript(() => {
    delete (window as { PushManager?: unknown }).PushManager;
  });
  const page = await context.newPage();
  await signIn(page, '/settings/notifications');
  await expect(page.getByTestId('this-device')).toContainText(
    'This browser cannot receive notifications.',
  );
  await expect(page.getByTestId('push-subscribe')).toHaveCount(0);
  await context.close();
});

test('Settings adds a messaging address after its test message, removes it, and switches mail', async ({
  context,
  page,
}) => {
  // The instance's stand-in for the services answers 200, or the status a path ends with.
  await routeToInstance(context);
  const webhook = 'https://hooks.slack.com/services/T0E2E/B0E2E/e2efixturetoken';
  await signIn(page, '/settings/notifications');
  const addresses = page.getByTestId('messaging-addresses');
  await expect(addresses.getByTestId('no-address')).toBeVisible();

  // ── A test message the service refuses: nothing kept, the status said ─
  const addForm = page.getByTestId('address-add-form');
  await addForm.getByLabel('Service').selectOption('slack');
  await addForm.getByLabel('Name').fill('Team channel');
  await addForm.getByLabel('Incoming webhook address').fill(`${webhook}/status-404`);
  await addForm.getByRole('button', { name: 'Add the address' }).click();
  await expect(page.getByTestId('channel-problem')).toContainText('the service answered 404');
  await expect(page.getByTestId('no-address')).toBeVisible();
  // Neither the page nor its URL repeats the address.
  expect(page.url()).not.toContain('e2efixturetoken');

  // ── Taken: kept, listed by name and service, never shown back ─────────
  await addForm.getByLabel('Service').selectOption('slack');
  await addForm.getByLabel('Name').fill('Team channel');
  await addForm.getByLabel('Incoming webhook address').fill(webhook);
  await addForm.getByRole('button', { name: 'Add the address' }).click();
  await expect(page.getByTestId('address-added')).toBeVisible();
  const list = page.getByTestId('addresses');
  await expect(list).toContainText('Team channel');
  await expect(list).toContainText('Slack');
  expect(await page.content()).not.toContain('e2efixturetoken');
  await snap(page, 'notifications-settings-address');

  // ── Removed, asked first ────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Remove Team channel' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Remove Team channel?');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('address-removed')).toBeVisible();
  await expect(page.getByTestId('no-address')).toBeVisible();

  // ── Mail: the person's own address, switched on, then off ──────────────
  const mail = page.getByTestId('mail-channel');
  await expect(mail).toContainText(`Mail to ${E2E_USER.email}`);
  await expect(mail.getByTestId('mail-state')).toHaveText('Off.');
  await mail.getByRole('button', { name: 'Turn mail on' }).click();
  await expect(page.getByTestId('mail-on')).toBeVisible();
  await expect(mail.getByTestId('mail-state')).toContainText('On');
  await mail.getByRole('button', { name: 'Turn mail off' }).click();
  await expect(page.getByTestId('mail-off')).toBeVisible();
  await expect(mail.getByTestId('mail-state')).toHaveText('Off.');
});
