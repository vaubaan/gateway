/**
 * Recovery by the master key in a browser (ADR administrators-live-in-the-instance §9):
 * the key file is read by the page, which proves holding it with Web Crypto without
 * sending it; the recovery session names one administrator; every page then says so.
 */
import { expect, test } from '@playwright/test';

import { passSecondFactor, routeToInstance, signInAs } from './browser';
import { controlUrl, E2E_OPERATOR, E2E_USER } from './instance';

test.beforeEach(async ({ context }) => {
  await routeToInstance(context);
});

test.afterEach(async ({ request }) => {
  await request.post(controlUrl('/recovery/cleanup'));
});

test('the master key, read in the browser, names an administrator — and every page says so', async ({
  page,
  request,
}) => {
  const key = (await (await request.get(controlUrl('/master-key'))).json()) as { file: string };
  let sentKey = false;
  page.on('request', (r) => {
    if ((r.postData() ?? '').includes(key.file.trim())) sentKey = true;
  });

  await page.goto('/admin/recover');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recover with the master key');
  // Not this gateway's key: refused.
  await page.getByTestId('master-key-file').setInputFiles({
    name: 'other.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`${Buffer.alloc(32, 7).toString('base64')}\n`),
  });
  await expect(page.getByTestId('recover-refused')).toBeVisible();

  await page.getByTestId('master-key-file').setInputFiles({
    name: 'vaubaan-master-key.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(key.file),
  });
  await expect(page.getByTestId('recover-name')).toBeVisible();
  await page.getByLabel('A person who has signed in').selectOption({ label: E2E_USER.email });
  await page.getByRole('button', { name: 'Make them administrator' }).click();
  await expect(page.getByTestId('recover-done')).toContainText(E2E_USER.email);
  expect(sentKey).toBe(false);

  // Loud: every page of the gateway says it, for thirty days.
  await signInAs(request, E2E_OPERATOR);
  await page.goto('/auth/login?return_to=/');
  await passSecondFactor(page, request, E2E_OPERATOR.email);
  await expect(page.getByTestId('recovery-banner')).toContainText(E2E_USER.email);
});
