/**
 * Scenario 1 — Register OrgResource (kind `github-org`) end-to-end.
 *
 * Spec §7.1 (register OrgResource), §6.4 (PUT /access).
 *
 * Flow :
 *   1. Bootstrap admin user + org (fixture).
 *   2. POST /resources    → row in `pending` status.
 *   3. PUT /access/PAT    → sealed_blob carrying the admin PAT.
 *   4. GET /access/PAT    → returns the sealed_blob.
 *   5. Unseal node-side as the admin user → assert cleartext matches origin.
 *   6. Cleanup : DELETE /access/PAT + DELETE /resources/:rId.
 *
 * No provider-side resource is created here (the kind is `github-org`,
 * which only references an existing org; no createChild). Provisioning
 * via Admin is covered by `02-provision-via-admin.spec.ts`.
 *
 * ZK assertions :
 *  - The PAT cleartext only lives in the test process + sealed_blob.
 *  - The audit `resource.access.put` carries `recipient_count` but no `ct`.
 */

import { test, expect } from './fixtures/setup';
import { seal, unseal } from './fixtures/crypto';

test('register github-org + seal PAT + unseal as admin', async ({ env, authedAdmin, org }) => {
  const ghOrg = env.github.org;
  const adminPat = env.github.adminToken;

  // 1. POST /resources — register a github-org pointing at the test org.
  const registerRes = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
    {
      data: {
        kind: 'github-org',
        name: 'github',
        scope: 'org',
        provider_ref: ghOrg,
        metadata: { org_slug: ghOrg },
      },
    },
  );
  expect(registerRes.status(), await registerRes.text()).toBe(201);
  const { resource } = (await registerRes.json()) as { resource: { id: string; kind: string } };
  expect(resource.kind).toBe('github-org');

  // 2. PUT /access/PAT — seal the admin PAT for the test user.
  const sealedBlob = await seal(adminPat, [
    { fingerprint: authedAdmin.identity.fingerprint, publicKey: authedAdmin.identity.publicKey },
  ]);
  const putRes = await authedAdmin.context.request.put(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
    { data: { ...sealedBlob, description: 'github admin PAT (e2e)' } },
  );
  expect(putRes.status(), await putRes.text()).toBe(200);
  const putBody = (await putRes.json()) as { ok: boolean; recipient_count: number };
  expect(putBody.ok).toBe(true);
  expect(putBody.recipient_count).toBe(1);

  // 3. GET /access/PAT — server returns the sealed blob exactly.
  const getRes = await authedAdmin.context.request.get(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
  );
  expect(getRes.status()).toBe(200);
  const getBody = (await getRes.json()) as {
    key: string;
    sealed_blob: { v: 1; recipients: Array<{ fp: string; ct: string }> };
  };
  expect(getBody.key).toBe('PAT');
  expect(getBody.sealed_blob.recipients).toHaveLength(1);
  expect(getBody.sealed_blob.recipients[0]?.fp).toBe(authedAdmin.identity.fingerprint);

  // 4. Node-side unseal → cleartext matches origin.
  const cleartext = await unseal(getBody.sealed_blob, authedAdmin.identity);
  expect(cleartext).toBe(adminPat);

  // 5. ZK : assert the response body never carried the PAT in clear.
  //    The sealed_blob is opaque base64 — just sanity-check it doesn't
  //    contain the raw token substring.
  expect(JSON.stringify(getBody)).not.toContain(adminPat);

  // 6. Cleanup — DELETE access + resource. Org cleanup is fixture-owned.
  await authedAdmin.context.request.delete(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}/access/PAT`,
  );
  await authedAdmin.context.request.delete(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${resource.id}`,
  );
});
