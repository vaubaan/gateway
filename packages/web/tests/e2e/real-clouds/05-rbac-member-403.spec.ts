/**
 * Scenario 5 — RBAC: member cannot PATCH a Resource. Spec §3.3, §8.
 *
 * Flow :
 *   1. Bootstrap admin user + org (fixture).
 *   2. Admin registers a github-org resource.
 *   3. Add a second user as `member` (service-role insert into
 *      org_members — RLS would block another admin from doing it
 *      via REST). Sign that user in via a second BrowserContext.
 *   4. Member calls GET /resources/:rId → 200 (RLS lets members
 *      read).
 *   5. Member calls PATCH /resources/:rId → 403 (RLS
 *      `resources_update_admin` denies non-admins).
 *   6. Member calls GET /access/:key → 200 (sealed_blob returned)
 *      but `unseal` for that user yields `null` (not a recipient
 *      yet — the trigger flipped recipients_stale=true, but the
 *      blob still only carries the admin's fp).
 *
 * Cleanup is fixture-owned (admin user + org).
 */

import { test, expect } from './fixtures/setup';
import { seal, generateE2EIdentity, identityToCryptoKeyPostBody, unseal } from './fixtures/crypto';

test('member can GET but cannot PATCH; access blob unsealable=null', async ({
  env,
  authedAdmin,
  org,
  admin,
  nameCtx,
  browser,
}) => {
  // 1. Admin registers github-org + seals the PAT for itself.
  const regRes = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
    {
      data: {
        kind: 'github-org',
        name: 'github',
        scope: 'org',
        provider_ref: env.github.org,
      },
    },
  );
  expect(regRes.status()).toBe(201);
  const resource = ((await regRes.json()) as { resource: { id: string } }).resource;

  const sealedPat = await seal('ghp_e2e_rbac_dummy', [
    {
      fingerprint: authedAdmin.identity.fingerprint,
      publicKey: authedAdmin.identity.publicKey,
    },
  ]);
  const putAccess = await authedAdmin.context.request.put(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
    { data: sealedPat },
  );
  expect(putAccess.status()).toBe(200);

  // 2. Create a second user, add them as `member` via service-role,
  //    sign them in in a separate browser context.
  const memberCreds = await admin.createTestUser({
    runUuid: nameCtx.runUuid,
    suffix: 'member',
  });
  await admin.addOrgMember({
    organizationId: org.id,
    userId: memberCreds.userId,
    role: 'member',
  });
  const memberIdentity = await generateE2EIdentity(memberCreds.password);
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();

  try {
    // Sign the member in via the /sign-in form, then seed their crypto-key.
    await memberPage.goto('/sign-in');
    await memberPage.getByLabel(/email/i).fill(memberCreds.email);
    await memberPage.getByLabel(/password/i).fill(memberCreds.password);
    await memberPage.getByRole('button', { name: /sign in|log in/i }).click();
    await memberPage.waitForURL((url) => /\/onboarding|\/orgs\//.test(url.pathname), {
      timeout: 15_000,
    });
    const seedRes = await memberCtx.request.post(`${env.baseUrl}/api/crm/v1/me/crypto-key`, {
      data: identityToCryptoKeyPostBody(memberIdentity),
    });
    expect([200, 201, 409]).toContain(seedRes.status());

    // 3. Member GET /resources/:rId → 200.
    const getRes = await memberCtx.request.get(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}`,
    );
    expect(getRes.status()).toBe(200);

    // 4. Member PATCH → 403 (RLS resources_update_admin denies).
    const patchRes = await memberCtx.request.patch(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}`,
      { data: { metadata: { hacked: true } } },
    );
    expect([403, 404]).toContain(patchRes.status());

    // 5. Member GET /access/:key → 200 (sealed_blob returned)
    //    but unseal yields null since the blob has only the admin's fp.
    const accessRes = await memberCtx.request.get(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
    );
    expect(accessRes.status()).toBe(200);
    const blob = (
      (await accessRes.json()) as {
        sealed_blob: { v: 1; recipients: ReadonlyArray<{ fp: string; ct: string }> };
      }
    ).sealed_blob;
    const decoded = await unseal(blob, memberIdentity);
    expect(decoded).toBeNull();
  } finally {
    await memberCtx.close().catch(() => undefined);
    await admin.deleteTestUser(memberCreds.userId).catch(() => undefined);
  }
});
