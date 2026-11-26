/**
 * Representative calls of every tool of the `supabase` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Every sample runs on one staging project, the branch tools on that project
 * and one of its preview branches ; the ones the classifier must refuse say so.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';

/** The one project the samples run on, labelled staging. */
export const EXAMPLE_STAGING_PROJECT: Resource = {
  service: SERVICE_ID,
  ref: STAGING_REF,
  env: 'staging',
  displayName: 'Acme / app-staging',
};

const p = { project_ref: STAGING_REF };

const BRANCH_REF = 'hrrzrckpczvaugzjrlie';

/** A preview branch of the staging project, as discovery describes it : labelled `preview`. */
export const EXAMPLE_PREVIEW_BRANCH: Resource = {
  service: SERVICE_ID,
  ref: BRANCH_REF,
  env: 'preview',
  displayName: 'Acme / app-staging / feature/login',
  metadata: { parent_project_ref: STAGING_REF, git_branch: 'feature/login', persistent: false },
};

/** The staging project and its preview branch. */
const withBranch = [EXAMPLE_STAGING_PROJECT, EXAMPLE_PREVIEW_BRANCH];
const b = { project_ref: BRANCH_REF };

export const supabaseExamples: ToolSamples = samplesOn([EXAMPLE_STAGING_PROJECT], {
  [TOOL.listProjects]: [{ args: {} }, { args: p, expectDenied: true }],
  [TOOL.getProject]: [{ args: p }, { args: {} }],
  [TOOL.getAnonKey]: [{ args: p }],
  [TOOL.listTables]: [{ args: { ...p, schemas: ['public', 'app'] } }],
  [TOOL.listMigrations]: [{ args: p }],
  [TOOL.executeSql]: [
    { args: { ...p, query: 'DELETE FROM users;' } },
    { args: p, expectDenied: true },
  ],
  [TOOL.getAdvisors]: [{ args: { ...p, type: 'security' } }],
  [TOOL.applyMigration]: [
    { args: { ...p, name: 'ddl', query: 'CREATE TABLE x(id int);' } },
    {
      args: {
        ...p,
        name: 'rls',
        query: 'CREATE POLICY p ON users USING (true); UPDATE users SET a = 1;',
      },
    },
    { args: { ...p, name: 'grant', query: 'grant select on t to anon;' } },
    { args: { ...p, name: 'ext', query: 'create extension if not exists vector;' } },
    { args: { ...p, name: 'fn', query: 'do $$ begin null; end $$;' } },
    {
      args: { ...p, name: 'no-sql', query: ['create table x(id int);'] },
      expectDenied: true,
    },
    {
      args: { ...p, projectRef: STAGING_REF, name: 'alias', query: 'select 1;' },
      expectDenied: true,
    },
  ],
  [TOOL.listBranches]: [{ args: p, resources: withBranch }],
  [TOOL.getBranch]: [
    { args: b, resources: withBranch },
    // The parent project is not a branch.
    { args: p, resources: withBranch, expectDenied: true },
  ],
  [TOOL.deleteBranch]: [
    { args: b, resources: withBranch },
    { args: p, resources: withBranch, expectDenied: true },
  ],
  [TOOL.resetBranch]: [
    { args: b, resources: withBranch },
    { args: p, resources: withBranch, expectDenied: true },
  ],
  [TOOL.listBuckets]: [{ args: p }],
  [TOOL.getStorageConfig]: [{ args: p }],
  [TOOL.updateStorageConfig]: [{ args: { ...p, config: {} } }],
  [TOOL.createBucket]: [
    { args: { ...p, id: 'b1', name: 'B1' } },
    { args: { ...p, name: 'has space' }, expectDenied: true },
  ],
  [TOOL.updateBucket]: [{ args: { ...p, id: 'b1' } }, { args: p, expectDenied: true }],
  [TOOL.deleteBucket]: [{ args: { ...p, id: 'b1' } }],
  [TOOL.listObjects]: [{ args: { ...p, bucket: 'b1' } }],
  [TOOL.uploadObject]: [
    { args: { ...p, bucket: 'b1', path: 'dir/p.txt', content_base64: 'AA' } },
    { args: { ...p, bucket: 'b1', content_base64: 'AA' }, expectDenied: true },
  ],
  [TOOL.deleteObject]: [{ args: { ...p, bucket: 'b1', path: 'p.txt' } }],
  [TOOL.createSignedUrl]: [
    { args: { ...p, bucket: 'b1', path: 'p.txt' } },
    { args: { ...p, bucket: 'b1', path: 'p.txt', expires_in: 86_400 } },
    { args: { ...p, bucket: 'b1', path: 'p.txt', expires_in: 86_401 }, expectDenied: true },
    { args: { ...p, bucket: 'b1', path: 'p.txt', expires_in: '3600' }, expectDenied: true },
  ],
  [TOOL.getAuthConfig]: [{ args: p }],
  [TOOL.updateAuthConfig]: [{ args: { ...p, config: {} } }],
  [TOOL.listSsoProviders]: [{ args: p }],
  [TOOL.getSsoProvider]: [{ args: { ...p, provider_id: 'sso1' } }],
  [TOOL.createSsoProvider]: [{ args: { ...p, type: 'saml' } }, { args: p, expectDenied: true }],
  [TOOL.updateSsoProvider]: [{ args: { ...p, provider_id: 'sso1' } }],
  [TOOL.deleteSsoProvider]: [{ args: { ...p, provider_id: 'sso1' } }],
  [TOOL.listThirdPartyAuth]: [{ args: p }],
  [TOOL.getThirdPartyAuth]: [{ args: { ...p, tpa_id: 't1' } }],
  [TOOL.createThirdPartyAuth]: [{ args: { ...p, type: 'oidc' } }],
  [TOOL.deleteThirdPartyAuth]: [{ args: { ...p, tpa_id: 't1' } }],
  [TOOL.listUsers]: [{ args: p }],
  [TOOL.getUser]: [{ args: { ...p, user_id: 'u1' } }, { args: p, expectDenied: true }],
  [TOOL.createUser]: [
    { args: { ...p, email: 'a@b.c' } },
    { args: { ...p, phone: '+33612345678' } },
    { args: p },
  ],
  [TOOL.updateUser]: [
    { args: { ...p, user_id: 'u1' } },
    { args: { ...p, user_id: 'bulk' } },
    { args: { ...p, user_id: 'u1', password: 'a new password' } },
  ],
  [TOOL.deleteUser]: [
    { args: { ...p, user_id: 'u1' } },
    { args: { ...p, user_id: ['u1'] }, expectDenied: true },
  ],
  [TOOL.generateLink]: [
    { args: { ...p, email: 'a@b.c', type: 'magiclink' } },
    { args: { ...p, email: 'a b', type: 'magiclink' }, expectDenied: true },
  ],
  [TOOL.listFunctions]: [{ args: p }],
  [TOOL.getFunction]: [{ args: { ...p, function_slug: 'fn1' } }],
  [TOOL.getFunctionBody]: [{ args: { ...p, function_slug: 'fn1' } }],
  [TOOL.listFunctionSecrets]: [{ args: p }],
  [TOOL.createFunction]: [{ args: { ...p, slug: 'fn1', body: 'x' } }],
  [TOOL.updateFunction]: [{ args: { ...p, function_slug: 'fn1' } }],
  [TOOL.deleteFunction]: [{ args: { ...p, function_slug: 'fn1' } }],
  [TOOL.deployFunction]: [
    {
      args: {
        ...p,
        slug: 'fn1',
        entrypoint_path: 'index.ts',
        files: [{ name: 'i', content: 'x' }],
      },
    },
    { args: { ...p, slug: 'fn1', entrypoint_path: 'index.ts', files: [] } },
  ],
  [TOOL.createFunctionSecrets]: [
    { args: { ...p, secrets: [{ name: 'K', value: 'v' }] } },
    { args: { ...p, secrets: [] }, expectDenied: true },
    { args: { ...p, secrets: [{ name: 'bad name', value: 'v' }] }, expectDenied: true },
  ],
  [TOOL.deleteFunctionSecrets]: [
    { args: { ...p, names: ['K'] } },
    { args: { ...p, names: [] }, expectDenied: true },
  ],
});
