/**
 * `@vaubaan/plugin-github` — the GitHub provider plugin.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/github.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates
 * the definition at import time ; the YAML catalog is loaded here, once,
 * when the module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyGithub } from './classify.ts';
import { githubCredential } from './credential.ts';
import { githubDataModel } from './data-model.ts';
import { discoverGithubResources, executeGithub } from './execute.ts';
import { githubTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const GITHUB_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const githubCatalog = loadCatalogFile(GITHUB_CATALOG_PATH);

export const githubPlugin = definePlugin({
  id: 'github',
  displayName: 'GitHub',
  version: '1.0.0',
  description:
    'Repositories, branches, files, pull requests, issues, releases and workflows of the GitHub App installation.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/github.md',
  tools: githubTools,
  dataModel: githubDataModel,
  catalog: githubCatalog.catalog,
  credential: githubCredential,
  classify: classifyGithub,
  execute: executeGithub,
  discoverResources: discoverGithubResources,
});

export default githubPlugin;

export { classifyGithub, githubCredential, githubDataModel, githubTools };
export { buildAppJwt, mintInstallationToken } from './app-install.ts';
export { discoverGithubResources, executeGithub, MINT_PERMISSIONS } from './execute.ts';
