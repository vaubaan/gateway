/**
 * Creating the company's GitHub App from Settings → Administration → Company
 * apps, in a browser (spec §4.2 "company apps", §6; ADR
 * company-app-created-from-a-manifest).
 *
 * The instance starts without a GitHub App (`/github-app/clear`). The
 * administrator picks the organisation, keeps the name, withholds Workflows
 * and lowers Administration, and is shown what will be created; the page's
 * form is posted to GitHub's registration address with the manifest the
 * server built and the single-use state. GitHub is not reached: the browser's
 * post is answered here, the way GitHub answers it — the manifest read, the
 * browser sent back to the manifest's `redirect_url` with a code and the state
 * — and the code exchange is answered by the launcher's mocked GitHub. The
 * page then shows the App and the next step. A replayed return is refused.
 * The company's App is put back afterwards (`/github-app/restore`).
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

import { routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_GITHUB_ORG, E2E_OPERATOR, PUBLIC_URL } from './instance';

const GITHUB_WEB = 'https://github.com';
const PAGE = '/admin/provider-apps?app=github#github';

/**
 * Keeps screenshots of the page when `E2E_V5_SCREENSHOT_DIR` names a folder: a
 * desktop and a phone width, both themes.
 */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (!dir) return;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
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

interface PostedToGithub {
  readonly url: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * GitHub's registration page, answered in the browser: what was posted is
 * recorded, and the browser is sent back as GitHub would after "Create".
 */
async function answerAsGithub(route: Route, request: APIRequestContext, posted: PostedToGithub[]) {
  const sent = route.request();
  const form = new URLSearchParams(sent.postData() ?? '');
  const manifest = JSON.parse(form.get('manifest') ?? '{}') as Record<string, unknown>;
  const state = new URL(sent.url()).searchParams.get('state') ?? '';
  posted.push({ url: sent.url(), manifest });
  const res = await request.post(controlUrl('/github-app/manifest'), {
    data: { manifest, state },
  });
  const { redirect } = (await res.json()) as { redirect: string };
  await route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta http-equiv="refresh" content="0;url=${redirect.replace(/&/g, '&amp;')}">`,
  });
}

test.beforeEach(async ({ context, request }) => {
  await control(request, '/github-app/clear');
  await routeToInstance(context);
});

test.afterEach(async ({ request }) => {
  await control(request, '/github-app/restore');
});

test('an administrator creates the GitHub App from Company apps, then is told to install it', async ({
  page,
  context,
  request,
}) => {
  const posted: PostedToGithub[] = [];
  await context.route(`${GITHUB_WEB}/**`, (route) => answerAsGithub(route, request, posted));

  await signInAs(request, E2E_OPERATOR);
  await page.goto(`/auth/login?return_to=${encodeURIComponent(PAGE)}`);
  await expect(page.getByRole('heading', { name: 'Company apps', level: 1 })).toBeVisible();

  // No App yet: the line opens on creating one, the form by hand one click away.
  const create = page.getByTestId('app-create-github');
  await expect(create).toBeVisible();
  await expect(create).toContainText('belongs to them');
  await expect(create).toContainText('never shown');
  await expect(create).toContainText('asks you to confirm');
  await expect(create.getByLabel('Name', { exact: true })).toHaveValue('Vaubaan gateway.e2e.test');
  // The sensitive permissions are explained, requested by default, and can be withheld.
  const workflows = create.getByTestId('app-permission-workflows');
  await expect(workflows).toContainText('Sensitive.');
  await expect(workflows).toContainText('Without it:');
  await expect(workflows.getByRole('combobox')).toHaveValue('write');
  await expect(create.getByTestId('app-permission-metadata')).toContainText('always');
  await snap(page, 'company-apps-create');

  await create.getByRole('link', { name: 'Enter an app registered by hand' }).click();
  const byHand = page.getByTestId('app-form-github');
  await expect(byHand).toBeVisible();
  await byHand.getByRole('link', { name: 'create it from here instead' }).click();
  await expect(page.getByTestId('app-create-github')).toBeVisible();

  // The organisation, the default name, Workflows withheld, Administration lowered.
  const form = page.getByTestId('app-create-github');
  await form.getByLabel('The organisation’s name').fill(E2E_GITHUB_ORG);
  await form.getByTestId('app-permission-workflows').getByRole('combobox').selectOption('none');
  await form
    .getByTestId('app-permission-administration')
    .getByRole('combobox')
    .selectOption('read');
  await form.getByRole('button', { name: 'Create the GitHub App' }).click();

  // What will be created, and the one button that posts it to GitHub.
  const confirm = page.getByTestId('app-create-confirm');
  await expect(confirm).toContainText(E2E_GITHUB_ORG);
  await expect(confirm).toContainText('Administration: read');
  await expect(confirm).not.toContainText('Workflows');
  const postForm = confirm.locator('form');
  const action = (await postForm.getAttribute('action')) ?? '';
  expect(action).toMatch(
    new RegExp(
      `^${GITHUB_WEB}/organizations/${E2E_GITHUB_ORG}/settings/apps/new\\?state=[\\w-]{40,}$`,
    ),
  );
  expect(await postForm.getAttribute('method')).toBe('post');
  const manifest = JSON.parse(
    (await postForm.locator('input[name="manifest"]').getAttribute('value')) ?? '{}',
  ) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    name: 'Vaubaan gateway.e2e.test',
    url: `${PUBLIC_URL}/`,
    redirect_url: `${PUBLIC_URL}/admin/provider-apps/github/created`,
    callback_urls: [`${PUBLIC_URL}/connections/callback/github`],
    request_oauth_on_install: true,
    public: false,
  });
  expect(manifest).not.toHaveProperty('hook_attributes');
  expect(manifest.default_permissions).toEqual({
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    actions: 'read',
    administration: 'read',
  });
  await snap(page, 'company-apps-confirm');

  // GitHub (answered here) asks to confirm, creates the App, sends the browser back.
  await confirm.getByRole('button', { name: 'Continue to GitHub' }).click();
  await expect(page.getByTestId('notice')).toContainText('is created');
  expect(posted).toHaveLength(1);
  expect(posted[0]!.url).toBe(action);

  // The App, its owner, its link, its permissions; the next step is installing it.
  const registered = page.getByTestId('registered-app');
  await expect(registered).toContainText('Vaubaan gateway.e2e.test');
  await expect(registered).toContainText(E2E_GITHUB_ORG);
  await expect(registered).toContainText('Administration: read');
  await expect(registered.getByRole('link', { name: 'Vaubaan gateway.e2e.test' })).toHaveAttribute(
    'href',
    'https://github.com/apps/vaubaan-gateway-e2e-test',
  );
  await expect(
    registered.getByRole('link', { name: 'Install it on your repositories' }),
  ).toHaveAttribute('href', '/accounts/new/github');
  // No secret on the page, and the line now says the App is registered.
  const html = await page.content();
  expect(html).not.toContain('PRIVATE KEY');
  await expect(page.getByTestId('company-apps')).toContainText('registered');
  await snap(page, 'company-apps-created');

  // GitHub's redirect replayed: the state was single-use, nothing changes.
  const back = new URL(action);
  await page.goto(
    `/admin/provider-apps/github/created?code=replayed&state=${back.searchParams.get('state') ?? ''}`,
  );
  await expect(page.getByTestId('notice')).toContainText('was not created');
  await expect(page.getByTestId('notice')).toContainText('does not match a creation started');
});

test('the form is not offered once an App is set, and an expired page says so', async ({
  page,
  request,
}) => {
  await control(request, '/github-app/restore');
  await signInAs(request, E2E_OPERATOR);
  await page.goto(`/auth/login?return_to=${encodeURIComponent(PAGE)}`);
  await expect(page.getByTestId('app-form-github')).toBeVisible();
  await expect(page.getByTestId('app-create-github')).toHaveCount(0);

  await page.goto(
    '/admin/provider-apps/github/confirm?state=nothing-waits-under-this-state-value-0000',
  );
  await expect(page.getByTestId('app-create-expired')).toContainText('no longer waiting');
});
