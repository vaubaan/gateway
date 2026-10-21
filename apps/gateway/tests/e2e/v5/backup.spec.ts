/**
 * The scheduled backup as an administrator and an external checker see it (ADR
 * scheduled-encrypted-backup-to-object-storage, D8). The e2e instance sets no
 * `backup.s3.*`: Settings → Encryption says it is off and how to turn it on, and
 * `/healthz` says `configured: false`. The runs themselves, against an S3 server, are
 * in `tests/integration/backup/scheduled-backup.test.ts`.
 */
import { expect, test } from '@playwright/test';

import { passSecondFactor, routeToInstance, signInAs } from './browser';
import { E2E_OPERATOR } from './instance';

test.beforeEach(async ({ context }) => {
  await routeToInstance(context);
});

test('an instance without a bucket says its scheduled backup is off, on the page and to a checker', async ({
  page,
  request,
}) => {
  await signInAs(request, E2E_OPERATOR);
  await page.goto(`/login?return_to=${encodeURIComponent('/admin/encryption')}`);
  await page.getByRole('link', { name: 'Continue with idp.e2e.test' }).click();
  await passSecondFactor(page, request, E2E_OPERATOR.email);
  await page.goto('/admin/encryption');

  const section = page.getByTestId('backup-status');
  await expect(section).toContainText('Scheduled backup');
  await expect(section).toContainText('Off. This gateway backs nothing up by itself.');
  await expect(section).toContainText('backup.s3.*');

  const health = await page.goto('/healthz');
  expect(health?.status()).toBe(200);
  const body = (await health?.json()) as { status: string; backup?: unknown };
  expect(body.status).toBe('ok');
  expect(body.backup).toEqual({ configured: false });
});
