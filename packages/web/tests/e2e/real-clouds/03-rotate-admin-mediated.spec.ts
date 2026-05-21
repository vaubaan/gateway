/**
 * Scenario 3 — Rotation admin-mediated for `SUPABASE_DB_PASSWORD`.
 *
 * Spec §0.1, §7.4. Flow :
 *
 *   1. Bootstrap admin user + org (fixture).
 *   2. Create a real Supabase project via the management API (slow:
 *      1-3 min, hence the long Playwright timeout).
 *   3. Register `supabase-org-admin` + `supabase-project` in Vauban,
 *      sealing the Supabase mgmt PAT + the initial db_pass.
 *   4. POST /access/SUPABASE_DB_PASSWORD/rotate — dispatcher returns
 *      `next_step=admin-rotate-child` with admin_resource_id.
 *   5. Browser-side `admin.rotateChildAccess`: PATCH the project to set
 *      a fresh CSPRNG password. The Management API returns 200 once
 *      the password reset is queued.
 *   6. PUT /access/SUPABASE_DB_PASSWORD with the new sealed blob.
 *   7. Assert : the new cleartext differs from the original, and
 *      `recipients_stale=false` again (Phase 6 wave B fix).
 *
 * What we DON'T assert (deferred to a future spec):
 *   - Direct psql connection with the old/new password (requires the
 *     pooler IP + a `pg` driver in devDeps, and Supabase's password
 *     reset is async — the new password isn't immediately effective
 *     on the pooler).
 *
 * Cleanup : delete the Supabase project via mgmt API.
 */

import { test, expect } from './fixtures/setup';
import { seal, unseal } from './fixtures/crypto';
import { makeResourceName } from './fixtures/naming';

function randomDbPass(): string {
  // Match the constraint enforced by Supabase ( >= 16 chars, mixed-case+digits+symbol).
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = 'Aa1$';
  for (let i = 0; i < 20; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'x';
  }
  return out;
}

test.describe('rotate admin-mediated (supabase-project SUPABASE_DB_PASSWORD)', () => {
  // Generous timeout: Supabase project provisioning can stretch >2 min.
  test.setTimeout(8 * 60 * 1000);

  test('PATCHes db_pass via mgmt API, reseals, recipients_stale=false', async ({
    env,
    authedAdmin,
    org,
    admin,
    supabaseMgmt,
    nameCtx,
  }) => {
    const project = await admin.createProject({
      organizationId: org.id,
      slug: `e2e-${nameCtx.runUuid}`,
      name: `e2e ${nameCtx.runUuid}`,
    });

    const initialPass = randomDbPass();
    const sbProjectName = makeResourceName(nameCtx, 'sb');

    // 1. Create Supabase project (slow).
    const sbProj = await supabaseMgmt.createProject({
      name: sbProjectName,
      region: 'eu-west-3',
      dbPass: initialPass,
    });

    try {
      // 2. Register supabase-org-admin in Vauban.
      const adminResReg = await authedAdmin.context.request.post(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
        {
          data: {
            kind: 'supabase-org-admin',
            name: 'supabase-admin',
            scope: 'org',
            providerRef: env.supabaseMgmt.orgSlug,
          },
        },
      );
      expect(adminResReg.status(), await adminResReg.text()).toBe(201);
      const adminResource = ((await adminResReg.json()) as { resource: { id: string } }).resource;

      const sealedSbToken = await seal(env.supabaseMgmt.token, [
        {
          fingerprint: authedAdmin.identity.fingerprint,
          publicKey: authedAdmin.identity.publicKey,
        },
      ]);
      const putAdminAccess = await authedAdmin.context.request.put(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${adminResource.id}/access/SUPABASE_TOKEN`,
        { data: sealedSbToken },
      );
      expect(putAdminAccess.status()).toBe(200);

      // 3. Register supabase-project child via /provision.
      const provRes = await authedAdmin.context.request.post(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${adminResource.id}/provision`,
        {
          data: {
            childKind: 'supabase-project',
            name: sbProjectName,
            project_id: project.id,
            variant: 'staging',
            provider_ref: sbProj.id,
          },
        },
      );
      expect(provRes.status(), await provRes.text()).toBe(201);
      const childRes = ((await provRes.json()) as { resource: { id: string } }).resource;

      // 4. Seal the initial DB password into Vauban.
      const sealedInitial = await seal(initialPass, [
        {
          fingerprint: authedAdmin.identity.fingerprint,
          publicKey: authedAdmin.identity.publicKey,
        },
      ]);
      const putDb = await authedAdmin.context.request.put(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${childRes.id}/access/SUPABASE_DB_PASSWORD`,
        { data: sealedInitial },
      );
      expect(putDb.status()).toBe(200);

      // 5. POST /rotate — dispatcher must return admin-mediated.
      const rotateRes = await authedAdmin.context.request.post(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${childRes.id}/access/SUPABASE_DB_PASSWORD/rotate`,
      );
      expect(rotateRes.status()).toBe(202);
      const dispatch = (await rotateRes.json()) as {
        rotation_method: string;
        next_step: string;
        admin_resource_id?: string;
      };
      expect(dispatch.rotation_method).toBe('admin-mediated');
      expect(dispatch.next_step).toBe('admin-rotate-child');
      expect(dispatch.admin_resource_id).toBe(adminResource.id);

      // 6. Browser-side admin.rotateChildAccess simulation: PATCH the
      //    project's db_pass via Supabase Management API. The test
      //    process plays the role of the browser (which would unseal
      //    the admin token first; we have it in env directly here).
      const newPass = randomDbPass();
      const patchRes = await fetch(`https://api.supabase.com/v1/projects/${sbProj.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.supabaseMgmt.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ db_pass: newPass }),
      });
      expect(patchRes.status, await patchRes.text()).toBeLessThan(300);

      // 7. PUT the new sealed blob into Vauban.
      const sealedNew = await seal(newPass, [
        {
          fingerprint: authedAdmin.identity.fingerprint,
          publicKey: authedAdmin.identity.publicKey,
        },
      ]);
      const putNew = await authedAdmin.context.request.put(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${childRes.id}/access/SUPABASE_DB_PASSWORD`,
        { data: sealedNew },
      );
      expect(putNew.status()).toBe(200);

      // 8. GET back the blob, unseal, assert new != old + length.
      const getBack = await authedAdmin.context.request.get(
        `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${childRes.id}/access/SUPABASE_DB_PASSWORD`,
      );
      expect(getBack.status()).toBe(200);
      const blob = (
        (await getBack.json()) as {
          sealed_blob: { v: 1; recipients: ReadonlyArray<{ fp: string; ct: string }> };
        }
      ).sealed_blob;
      const decoded = await unseal(blob, authedAdmin.identity);
      expect(decoded).toBe(newPass);
      expect(decoded).not.toBe(initialPass);

      // 9. recipients_stale=false right after the fresh PUT.
      const accessRow = await admin.selectResourceAccess({
        resourceId: childRes.id,
        key: 'SUPABASE_DB_PASSWORD',
      });
      expect(accessRow?.recipients_stale).toBe(false);
    } finally {
      // Always delete the Supabase project — billable resource even
      // on the free tier (org slot consumed).
      await supabaseMgmt.deleteProject(sbProj.id).catch(() => undefined);
    }
  });
});
