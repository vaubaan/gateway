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
 *
 * The legacy v4 exports at the bottom keep `apps/gateway` compiling until
 * the execution door (P1.6) replaces the v4 gateway ; they are deleted with it.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyGithub } from './classify.ts';
import { githubCredential } from './credential.ts';
import { githubDataModel } from './data-model.ts';
import { discoverGithubResources, executeGithub } from './execute.ts';
import { githubTools } from './tools.ts';

/**
 * The catalog path is a string resolved from `import.meta.url` rather than
 * `new URL('./risk-catalog.yaml', import.meta.url)` : the Next.js bundler of
 * the v4 app treats the latter as an asset import and hands the loader a
 * URL it cannot read (same rule as `apps/gateway/src/server/store/migrate.ts`).
 */
export const GITHUB_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'risk-catalog.yaml',
);

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

// ─────────────────────────────────────────────────────────────────────────────
// Legacy v4 surface — deleted in P1.6 with the v4 gateway.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated legacy v4, deleted in P1.6 — use `githubPlugin.tools`. */
export const githubAvailableTools = githubTools;
/** @deprecated legacy v4, deleted in P1.6 — use `githubPlugin.catalog`. */
export const githubRiskCatalog = githubCatalog.catalog;
// legacy v4, deleted in P1.6
export { GitHubAdapter } from './github-adapter.ts';
// legacy v4, deleted in P1.6
export { classifyGithubV4, type ClassifyV4Result } from './risk-classifier.ts';
