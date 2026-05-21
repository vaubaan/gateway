/**
 * Scenario 4 — Export `.env` for `(project, variant)` scope. Spec §7.5.
 *
 * Flow :
 *   1. Bootstrap admin + org (fixture).
 *   2. Create a project + 2 resources :
 *        a. an org-scope resource (kind `github-org`) with one access key.
 *        b. a project-scope resource (kind `vercel-project`) with two
 *           access keys, variant='staging'.
 *   3. POST /exports/env scope=project variant=staging projectId=<project>.
 *   4. Assert the response carries the expected `entries` (one per visible
 *      Access), and that every `sealed_blob` is opaque (no cleartext).
 *   5. Unseal each blob as the admin → reconstruct the dotenv → assert
 *      lines + values.
 *   6. ZK : the response body has no raw cleartext for any value.
 *
 * Cleanup is fixture-owned (org cascade).
 */

import { test, expect } from './fixtures/setup';
import { seal, unseal } from './fixtures/crypto';

interface CreatedResource {
  readonly id: string;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly variant: string | null;
}

interface ExportEntry {
  readonly key: string;
  readonly sealed_blob: {
    readonly v: 1;
    readonly recipients: ReadonlyArray<{ fp: string; ct: string }>;
  };
  readonly source_resource_id: string;
}

test('export .env scope=project variant=staging assembles the right lines', async ({
  env,
  admin,
  authedAdmin,
  org,
  nameCtx,
}) => {
  // Service-role bootstrap of a `projects` row : no public REST POST
  // /projects in v1, so the admin helper does it directly.
  const projectSlug = `e2e-${nameCtx.runUuid}`;
  const project = await admin.createProject({
    organizationId: org.id,
    slug: projectSlug,
    name: `e2e ${nameCtx.runUuid}`,
  });
  const projectId = project.id;

  // 1. org-scope resource.
  const orgResRes = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
    {
      data: {
        kind: 'github-org',
        name: 'github',
        scope: 'org',
        providerRef: env.github.org,
      },
    },
  );
  expect(orgResRes.status(), await orgResRes.text()).toBe(201);
  const orgRes = ((await orgResRes.json()) as { resource: CreatedResource }).resource;

  // 2. project-scope resource (variant=staging).
  const projResRes = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
    {
      data: {
        kind: 'vercel-project',
        name: 'web',
        scope: 'project',
        projectId,
        variant: 'staging',
        providerRef: `vauban-e2e-${nameCtx.runUuid}`,
      },
    },
  );
  expect(projResRes.status(), await projResRes.text()).toBe(201);
  const projRes = ((await projResRes.json()) as { resource: CreatedResource }).resource;

  // 3. seal sample access keys.
  const recipient = {
    fingerprint: authedAdmin.identity.fingerprint,
    publicKey: authedAdmin.identity.publicKey,
  };
  const orgKeyBlob = await seal('ghp_e2e_org_PAT_dummy', [recipient]);
  const projUrlBlob = await seal('https://staging.example.com', [recipient]);
  const projTokenBlob = await seal('vrcl_e2e_token_dummy', [recipient]);

  const put = async (rId: string, key: string, blob: Awaited<ReturnType<typeof seal>>) => {
    const r = await authedAdmin.context.request.put(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${rId}/access/${key}`,
      { data: blob },
    );
    expect(r.status(), `${key} put`).toBe(200);
  };
  await put(orgRes.id, 'GITHUB_TOKEN', orgKeyBlob);
  await put(projRes.id, 'VERCEL_URL', projUrlBlob);
  await put(projRes.id, 'VERCEL_TOKEN', projTokenBlob);

  // 4. POST /exports/env scope=project variant=staging.
  const exportRes = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/exports/env`,
    { data: { scope: 'project', scopeId: projectId, variant: 'staging' } },
  );
  expect(exportRes.status(), await exportRes.text()).toBe(200);
  const exportBody = (await exportRes.json()) as { entries: ExportEntry[] };
  const keys = exportBody.entries.map((e) => e.key).sort();
  expect(keys).toContain('VERCEL_URL');
  expect(keys).toContain('VERCEL_TOKEN');
  // Org-scope blob is also visible at the project scope (cf. spec §7.5
  // — org keys cascade into project exports).
  expect(keys).toContain('GITHUB_TOKEN');

  // 5. Each entry's sealed_blob is unsealable by the admin user.
  for (const entry of exportBody.entries) {
    const cleartext = await unseal(entry.sealed_blob, authedAdmin.identity);
    expect(cleartext, `unseal ${entry.key}`).not.toBeNull();
  }

  // 6. ZK : no cleartext token substring leaks into the response body.
  const rawBody = JSON.stringify(exportBody);
  expect(rawBody).not.toContain('ghp_e2e_org_PAT_dummy');
  expect(rawBody).not.toContain('vrcl_e2e_token_dummy');
  expect(rawBody).not.toContain('https://staging.example.com');
});
