#!/usr/bin/env node
/**
 * Capture marketing screenshots from prod (or any E2E_BASE_URL) for use in
 * marketplace submissions (Vercel, Supabase Partners, GitHub Marketplace).
 *
 * Vercel rejects anything that isn't 16:9 ≥ 1920×1080. This script captures
 * exactly that, logged in as the seeded test user against /orgs/sbw-vaubaan
 * (the fake-customer org seeded by `tsx scripts/seed-test-customer.ts`).
 *
 * Output : packages/web/public/marketing/screenshots/*.png.
 *
 * Usage  : node scripts/capture-marketing-screenshots.mjs
 *          (optional env: E2E_BASE_URL, E2E_USER_EMAIL, E2E_USER_PASSWORD,
 *          E2E_ORG_SLUG, E2E_PROJECT_SLUG)
 *
 * Pre-req : `npx playwright install chromium` once.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../packages/web/public/marketing/screenshots');
const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';
const EMAIL = process.env.E2E_USER_EMAIL ?? 'test@vaubaan.com';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'VaubanTest!2026';
const ORG = process.env.E2E_ORG_SLUG ?? 'sbw-vaubaan';
const PROJECT = process.env.E2E_PROJECT_SLUG ?? 'playground';

const SHOTS = [
  { path: `/orgs/${ORG}`, name: 'organization' },
  { path: `/orgs/${ORG}/projects/${PROJECT}`, name: 'project' },
  { path: `/orgs/${ORG}/projects/${PROJECT}/tokens`, name: 'tokens' },
  { path: `/orgs/${ORG}/roles`, name: 'roles' },
  { path: `/orgs/${ORG}/audit`, name: 'audit' },
];

mkdirSync(OUT, { recursive: true });
console.log(`> base=${BASE} user=${EMAIL} out=${OUT}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

await page.goto(`${BASE}/login`);
await page.locator('input[type=email]').first().fill(EMAIL);
await page.locator('input[type=password]').first().fill(PASSWORD);
await page
  .getByRole('button', { name: /sign in/i })
  .first()
  .click();
await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
console.log('  logged in');

for (const s of SHOTS) {
  await page.goto(`${BASE}${s.path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const out = `${OUT}/${s.name}.png`;
  await page.screenshot({
    path: out,
    fullPage: false,
    clip: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  console.log(`  ${s.name}.png  ←  ${s.path}`);
}

await browser.close();
console.log('done.');
