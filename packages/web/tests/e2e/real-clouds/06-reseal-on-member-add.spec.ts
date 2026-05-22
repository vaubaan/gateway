/**
 * Scenario 6 — Re-seal on membership change. Spec §4.5.
 *
 * Flow :
 *   1. Admin registers a github-org resource, seals a PAT for
 *      themselves.
 *   2. Add a new member via service-role (INSERT into org_members).
 *      The trigger added by migration 1003 flips
 *      `recipients_stale=true` on every Resource of that org.
 *   3. Admin re-seals the PAT for both recipients (self + new member)
 *      and PUTs the new sealed_blob. The PUT handler resets
 *      `recipients_stale=false`.
 *   4. New member GETs /access/PAT → unseal as themselves works,
 *      returns the same PAT cleartext.
 *
 * What the migration 1003 trigger does end-to-end : visible at step 2.
 */

import { test, expect } from './fixtures/setup';
import { generateE2EIdentity, identityToCryptoKeyPostBody, seal, unseal } from './fixtures/crypto';

test('member add flips recipients_stale; re-seal restores unseal-ability', async ({
  env,
  authedAdmin,
  org,
  admin,
  nameCtx,
  browser,
}) => {
  // 1. Admin registers github-org + seals PAT for self only.
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

  const originalPat = 'ghp_e2e_reseal_dummy_pat';
  const sealedForSelf = await seal(originalPat, [
    {
      fingerprint: authedAdmin.identity.fingerprint,
      publicKey: authedAdmin.identity.publicKey,
    },
  ]);
  await authedAdmin.context.request.put(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
    { data: sealedForSelf },
  );

  // 2. Add new member via service-role. Their crypto-key must exist
  //    in user_crypto_keys before we re-seal (we need their pubkey).
  const memberCreds = await admin.createTestUser({
    runUuid: nameCtx.runUuid,
    suffix: 'newmem',
  });
  const memberIdentity = await generateE2EIdentity(memberCreds.password);

  // Sign the member in once so we can POST their crypto-key via their
  // own session (the endpoint is RLS-gated to the calling user).
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  try {
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

    // Insert the org_members row — the trigger (migration 1003) fires.
    await admin.addOrgMember({
      organizationId: org.id,
      userId: memberCreds.userId,
      role: 'member',
    });

    // 3. Trigger assertion: recipients_stale=true on the existing blob.
    const staleRow = await admin.selectResourceAccess({
      resourceId: resource.id,
      key: 'PAT',
    });
    expect(staleRow?.recipients_stale).toBe(true);

    // 4. Admin re-seals for both recipients (self + new member).
    const reSealed = await seal(originalPat, [
      {
        fingerprint: authedAdmin.identity.fingerprint,
        publicKey: authedAdmin.identity.publicKey,
      },
      { fingerprint: memberIdentity.fingerprint, publicKey: memberIdentity.publicKey },
    ]);
    const putRes = await authedAdmin.context.request.put(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
      { data: reSealed },
    );
    expect(putRes.status()).toBe(200);

    // 5. recipients_stale flips back to false after the fresh PUT.
    const freshRow = await admin.selectResourceAccess({
      resourceId: resource.id,
      key: 'PAT',
    });
    expect(freshRow?.recipients_stale).toBe(false);

    // 6. Member GETs the blob and unseals it correctly.
    const accessRes = await memberCtx.request.get(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
    );
    expect(accessRes.status()).toBe(200);
    const blob = (
      (await accessRes.json()) as {
        sealed_blob: { v: 1; recipients: ReadonlyArray<{ fp: string; ct: string }> };
      }
    ).sealed_blob;
    const cleartext = await unseal(blob, memberIdentity);
    expect(cleartext).toBe(originalPat);
  } finally {
    await memberCtx.close().catch(() => undefined);
    await admin.deleteTestUser(memberCreds.userId).catch(() => undefined);
  }
});
