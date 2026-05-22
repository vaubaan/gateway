/**
 * Scenario 2 — Provision via Admin. Spec §7.3.
 *
 * Flow against a real GitHub org (`sbw-vauban-test`) :
 *   1. Bootstrap admin user + org (fixture).
 *   2. Register a `github-org-admin` resource with the admin PAT
 *      sealed for the test user.
 *   3. Browser-side createChild: simulate the admin flow by calling
 *      `gh.createRepo(name)` from the test process (representing the
 *      browser using the unsealed admin token).
 *   4. POST /resources/:adminId/provision with the new repo's
 *      provider_ref.
 *   5. Assert the row appears in /resources list with kind=github-repo,
 *      admin_resource_id=<the admin>, status=pending|active.
 *   6. Assert the repo really exists at GitHub via `gh.repoExists`.
 *   7. Cleanup : DELETE Vauban row + `gh.deleteRepo`.
 *
 * If the test crashes between createRepo and deleteRepo, the
 * sweeper picks the repo up (matches `vauban-e2e-*`).
 */

import { test, expect } from './fixtures/setup';
import { seal } from './fixtures/crypto';
import { makeResourceName } from './fixtures/naming';

test('provision github-repo via github-org-admin against real GitHub', async ({
  env,
  authedAdmin,
  org,
  gh,
  admin,
  nameCtx,
}) => {
  // 0. Bootstrap a project to host the future ProjectResource.
  const project = await admin.createProject({
    organizationId: org.id,
    slug: `e2e-${nameCtx.runUuid}`,
    name: `e2e ${nameCtx.runUuid}`,
  });

  // 1. Register github-org-admin.
  const adminResReg = await authedAdmin.context.request.post(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources`,
    {
      data: {
        kind: 'github-org-admin',
        name: 'github-admin',
        scope: 'org',
        provider_ref: env.github.org,
        metadata: { org_slug: env.github.org },
      },
    },
  );
  expect(adminResReg.status(), await adminResReg.text()).toBe(201);
  const adminResource = ((await adminResReg.json()) as { resource: { id: string } }).resource;

  // 2. Seal admin PAT.
  const sealedAdminPat = await seal(env.github.adminToken, [
    { fingerprint: authedAdmin.identity.fingerprint, publicKey: authedAdmin.identity.publicKey },
  ]);
  const putAccess = await authedAdmin.context.request.put(
    `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${adminResource.id}/access/PAT`,
    { data: sealedAdminPat },
  );
  expect(putAccess.status(), await putAccess.text()).toBe(200);

  // 3. Browser-side createChild simulation: real GitHub API call from
  //    the test process. The repo name follows the vauban-e2e-… pattern
  //    so the sweeper catches it on crash.
  const repoName = makeResourceName(nameCtx, 'repo');
  const repo = await gh.createRepo(repoName, { private: true });
  expect(repo.full_name).toBe(`${env.github.org}/${repoName}`);

  try {
    // 4. POST /resources/:adminId/provision — book-keeping side.
    const provRes = await authedAdmin.context.request.post(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${adminResource.id}/provision`,
      {
        data: {
          childKind: 'github-repo',
          name: repoName,
          project_id: project.id,
          variant: 'staging',
          provider_ref: repo.full_name,
          metadata: { org: env.github.org, repo: repoName },
        },
      },
    );
    expect(provRes.status(), await provRes.text()).toBe(201);
    const childRes = ((await provRes.json()) as { resource: { id: string; kind: string } })
      .resource;
    expect(childRes.kind).toBe('github-repo');

    // 5. /resources list contains the new child.
    const listRes = await authedAdmin.context.request.get(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources?projectId=${project.id}`,
    );
    expect(listRes.status()).toBe(200);
    const { resources } = (await listRes.json()) as {
      resources: Array<{ id: string; admin_resource_id: string | null }>;
    };
    const found = resources.find((r) => r.id === childRes.id);
    expect(found).toBeTruthy();
    expect(found?.admin_resource_id).toBe(adminResource.id);

    // 6. Provider-side confirmation : the repo really exists at GitHub.
    expect(await gh.repoExists(repoName)).toBe(true);

    // 7. Cleanup CRM row.
    await authedAdmin.context.request.delete(
      `${env.baseUrl}/api/crm/v1/orgs/${org.id}/resources/${childRes.id}`,
    );
  } finally {
    // Always destroy the GitHub repo, even if the asserts above failed.
    await gh.deleteRepo(repoName).catch(() => undefined);
  }
});
